/**
 * What a caller learns when its natural-key write lands on a trashed row.
 *
 * `POST /items` short-circuits to an acknowledgement when `(source,
 * source_id)` resolves a row the user has trashed: nothing is written and
 * nothing is published, because reviving the row would overturn a deletion
 * the user chose and refusing forever wedges the connector on one item.
 *
 * **The acknowledgement is right and what it hands back was never decided.**
 * It sat above every gate on the resolved row, so the answer to "what may a
 * caller learn here" was whatever the position of a `return` produced. Three
 * axes live under that question and they do not have the same answer:
 *
 *  - **The row itself: yes.** Everything the natural key bounds is already
 *    the caller's own. `source` is stamped from its credential and cannot be
 *    chosen, and it supplied the `source_id`. Seeing a row it addressed by
 *    a key only its own source can
 *    resolve tells it nothing it could not have written.
 *  - **The extension namespaces: no.** That axis is not bounded by the
 *    natural key at all. `extension_permissions` are per credential, so a
 *    row can carry namespaces the caller holds nothing on — written by a
 *    a person, by another tool, or by a sibling Connection of the same
 *    connector, all of which share the source that resolved it.
 *  - **The type: no.** The natural key resolves on the credential's stamped
 *    `source`, which outlives any narrowing of what that credential may
 *    write, so a credential whose `type_permissions` are cut back still
 *    reaches every row it wrote before the cut. The update branch below
 *    refuses those on the resolved row's type; the acknowledgement above it
 *    did not, so the two branches disagreed about who may address one row.
 *
 * The narrowing is modeled by editing the credential that wrote the row,
 * because nothing else can reach it: `source` is unique among
 * unrevoked credentials, so no second credential resolves the same natural
 * key. Cutting that one credential's permission map produces the state the
 * resolved-row gates exist for, a reachable row the caller may no longer
 * write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

const SYNCED = "user.synced_row";
const PRIVATE_NS = "acme.private";
const GRANTED_NS = "acme.probe";

beforeAll(async () => {
  ctx = await createTestContext();
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: SYNCED, version: 1, fields: { title: { type: "string" } } },
  });
  expect(registered.status).toBe(201);
});

afterAll(async () => {
  await ctx.cleanup();
});

interface SyncKey {
  id: string;
  key: string;
  source: string;
}

/**
 * A credential whose stamped `source` fixes its natural-key namespace.
 *
 * Not the operator key, which is the instance tier and reaches no content at
 * all. Both maps below decide every type and every
 * `acme.*` namespace this credential touches, which is what each case here
 * asserts.
 */
async function syncCredential(options: {
  types: Record<string, "read" | "write">;
  extensions: Record<string, "read" | "write">;
}): Promise<SyncKey> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_sync_${suffix}`;
  const source = `sync-${suffix}`;
  const created = await ctx.storage.keys.create(
    {
      label: `sync-${suffix}`,
      source,
      type_permissions: options.types,
      extension_permissions: options.extensions,
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { id: created.id, key: raw, source };
}

/**
 * A trashed row at this credential's `(source, sourceId)`, carrying one
 * namespace the credential wrote and one a person did.
 */
async function trashedRow(cred: SyncKey, sourceId: string): Promise<string> {
  const created = await request(ctx.app, "POST", "/items", {
    key: cred.key,
    body: { type: SYNCED, source_id: sourceId, properties: { title: "s" } },
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;

  const own = await request(
    ctx.app,
    "PUT",
    `/items/${id}/extensions/${GRANTED_NS}`,
    {
      key: cred.key,
      body: { note: "written by the connector" },
    },
  );
  expect(own.status).toBe(200);

  // The namespace the caller holds nothing on. An admin annotating a
  // connector's row is the ordinary way this happens.
  const admin = await request(
    ctx.app,
    "PUT",
    `/items/${id}/extensions/${PRIVATE_NS}`,
    { key: ctx.workingKey, body: { secret: "not the caller's to read" } },
  );
  expect(admin.status).toBe(200);

  const trashed = await request(ctx.app, "POST", `/items/${id}/transition`, {
    key: cred.key,
    body: { state: "trashed" },
  });
  expect(trashed.status).toBe(200);
  return id;
}

describe("the trashed-row acknowledgement", () => {
  it("hands back only the extension namespaces the caller may read", async () => {
    const cred = await syncCredential({
      types: { [SYNCED]: "write" },
      extensions: { [GRANTED_NS]: "write" },
    });
    await trashedRow(cred, "row-1");

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      body: { type: SYNCED, source_id: "row-1", properties: { title: "re" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acknowledged?: boolean;
      metadata?: { extensions?: Record<string, unknown> };
    };
    expect(body.acknowledged).toBe(true);

    const namespaces = Object.keys(body.metadata?.extensions ?? {});
    // Both halves. Asserting only the absence would pass on a response
    // carrying no extensions at all, which is a different defect.
    expect(namespaces).toContain(GRANTED_NS);
    expect(namespaces).not.toContain(PRIVATE_NS);
  });

  it("still acknowledges, so the connector is not wedged", async () => {
    // The behavior this branch exists for. Pinned beside the filter so a
    // later tightening cannot quietly reintroduce the 409-forever bug it
    // was written to fix.
    const cred = await syncCredential({
      types: { [SYNCED]: "write" },
      extensions: { [GRANTED_NS]: "write" },
    });
    await trashedRow(cred, "row-2");

    const first = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      body: { type: SYNCED, source_id: "row-2", properties: { title: "a" } },
    });
    expect(first.status).toBe(200);
    // Twice, because "not wedged" is a claim about the second attempt.
    const second = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      body: { type: SYNCED, source_id: "row-2", properties: { title: "b" } },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { acknowledged?: boolean };
    expect(body.acknowledged).toBe(true);
  });

  it("refuses a caller that may no longer write the resolved row's type", async () => {
    const cred = await syncCredential({
      types: { [SYNCED]: "write", "core.note": "write" },
      extensions: { [GRANTED_NS]: "write" },
    });
    await trashedRow(cred, "row-3");

    // The narrowing: the row stays reachable by natural key and the
    // credential that wrote it loses write on its type.
    await ctx.storage.keys.update(cred.id, {
      type_permissions: { "core.note": "write" },
    });

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      // A type it does hold, which is the escalation vector the resolved-row
      // gates exist to close: the claim is not the row.
      body: {
        type: "core.note",
        source_id: "row-3",
        properties: { body: "re" },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_not_permitted");
  });
});
