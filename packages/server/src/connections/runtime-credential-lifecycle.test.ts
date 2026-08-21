/**
 * What a runtime credential is bound to, and for how long.
 *
 * Four properties, each of which was violated in a way that produced no
 * error, no log line and no failing test:
 *
 *   1. A credential is fenced by a space. A Connection installed
 *      without one produced a credential with no `space_id`, which is
 *      not a narrow credential but the platform tier: the RLS wrapper
 *      skips it and the storage layer drops its space predicate, so
 *      reading `core.note` returned other customers' rows.
 *   2. A credential's item provenance survives its own rotation. The
 *      stamped `source` used to be the credential's, which changes on
 *      every mint, so upsert identity `(source, source_id)` moved with
 *      it and every refresh forked the integration's corpus.
 *   3. A mint cannot outlive the uninstall it raced. The state check and
 *      the write were not serialized against the pipeline that revokes
 *      credentials and revokes the Connection.
 *   4. A credential speaks only for its own Connection. The
 *      `system.activity` carve-out is about the type; it said nothing
 *      about whose activity a row claimed to be.
 *
 * Boots in `hosted` mode because three of the four are only wrong on a
 * deployment that has spaces.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MarfaError } from "@withmarfa/shared";
import type { IntegrationManifest } from "@withmarfa/shared";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

const INTEGRATION = "acme/lifecycle";

type MintOutcome =
  | { ok: true; api_key: string }
  | { ok: false; code: string; message: string };

interface ErrorResponse {
  error: { code: string; message: string };
}

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "Runtime credential lifecycle fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    permissions: {},
  };
}

async function makeIntegration(name = INTEGRATION): Promise<string> {
  const m = manifest(name);
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return integration.id;
}

async function makeConnection(
  spaceId: string | undefined,
  name = INTEGRATION,
): Promise<string> {
  const integrationId = await makeIntegration(name);
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integrationId,
      },
    },
    spaceId,
  );
  return connection.id;
}

async function mint(connectionId: string): Promise<MintOutcome> {
  // The runtime's own mint path — the only way a runtime credential is
  // created since the HTTP mint route was retired with the hosted
  // substrate.
  try {
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "hosted",
    );
    return { ok: true, api_key: cred.api_key };
  } catch (err) {
    if (err instanceof MarfaError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: "mint_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("a runtime credential is fenced by a space", () => {
  it("refuses to mint for a Connection with no space", async () => {
    const spaceA = await ctx.storage.spaces!.create("A");
    const spaceB = await ctx.storage.spaces!.create("B");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "a-note" } },
      spaceA.id,
    );
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "b-note" } },
      spaceB.id,
    );

    // A platform admin can install a Connection without naming a space.
    // Nothing downstream notices until the credential minted for it
    // starts reading, at which point it reads everything.
    const connectionId = await makeConnection(undefined);
    const res = await mint(connectionId);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("forbidden");
    expect(res.message).toMatch(/no space/i);
  });

  it("refuses the install pipeline's mint for a space-less Connection", async () => {
    // The third mint path. A platform admin's credential carries no
    // space, so `POST /connections/install` stamps none on the
    // Connection it creates and the credential minted for it comes out
    // at the platform tier. The refusal has to reach this door too, or
    // the rule is enforced on two of three.
    const integrationId = await makeIntegration("acme/install-fence");
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: integrationId },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/no space/i);

    // The compensating writes ran: nothing is left installed, and no
    // credential outlives the refusal.
    const connections = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(
      connections.data.filter(
        (c) => c.properties.integration_ref === integrationId,
      ),
    ).toHaveLength(0);
  });

  it("keeps minting for a Connection that has one", async () => {
    // The guard must refuse the space-less case and nothing else, or it
    // would take every integration offline rather than one broken
    // install.
    const space = await ctx.storage.spaces!.create("scoped");
    const connectionId = await makeConnection(space.id);
    expect((await mint(connectionId)).ok).toBe(true);
  });
});

describe("item provenance survives a credential rotation", () => {
  it("upserts under the same source across two mints", async () => {
    const space = await ctx.storage.spaces!.create("provenance");
    const connectionId = await makeConnection(space.id);

    const first = await mint(connectionId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const created = await request(ctx.app, "POST", "/items", {
      key: first.api_key,
      body: {
        type: "core.note",
        source_id: "upstream-42",
        properties: { body: "first write" },
      },
    });
    expect(created.status).toBe(201);
    const firstItem = (
      (await created.json()) as { item: { id: string; source: string } }
    ).item;

    // The rotation the runtime performs across dispatches.
    const second = await mint(connectionId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    const rewritten = await request(ctx.app, "POST", "/items", {
      key: second.api_key,
      body: {
        type: "core.note",
        source_id: "upstream-42",
        properties: { body: "second write" },
      },
    });
    // 200, not 201: the upsert found the existing row. A 201 here is the
    // defect — the same upstream record stored twice, silently, once per
    // credential generation.
    expect(rewritten.status).toBe(200);
    const secondItem = (
      (await rewritten.json()) as { item: { id: string; source: string } }
    ).item;

    expect(secondItem.id).toBe(firstItem.id);
    expect(secondItem.source).toBe(firstItem.source);
    // Keyed on the integration and the space, so it survives a credential
    // rotation and an uninstall-reinstall alike.
    expect(firstItem.source).toBe(`integration:${INTEGRATION}`);
  });
});

describe("a mint cannot outlive the uninstall it raced", () => {
  it("blocks on the Connection lifecycle lock and re-reads state under it", async () => {
    const space = await ctx.storage.spaces!.create("race");
    const connectionId = await makeConnection(space.id);

    let settled = false;
    let result: MintOutcome | null = null;

    // Hold the lock the uninstall pipeline takes for the whole of its
    // run, and revoke inside it exactly as step 7 of that pipeline does.
    // A mint that does not serialize against uninstall completes here,
    // against a Connection that is about to stop existing.
    await ctx.storage.coordination.withExclusiveLock(
      `connection-lifecycle:${connectionId}`,
      async () => {
        void mint(connectionId).then((r) => {
          settled = true;
          result = r;
          return r;
        });
        // Asserted before the revoke rather than after: what is being
        // pinned is that the mint is still waiting, not merely that it
        // ends up refused. An absence check is bounded by time, not a
        // condition — a blocked promise cannot be made to resolve by
        // scheduling delay, so load can weaken this half toward a
        // vacuous pass but never invert it into a false failure.
        await new Promise((r) => setTimeout(r, 200));
        expect(settled).toBe(false);
        await ctx.storage.items.transition(connectionId, "revoked", space.id);
      },
    );

    // The positive half gates on the condition, not the clock: under
    // machine load the released mint can take far longer than a fixed
    // sleep allows, and this wait costs nothing when it is quick.
    await vi.waitFor(
      () => {
        if (!settled) {
          throw new Error("mint has not settled after the lock released");
        }
      },
      { timeout: 15_000 },
    );
    expect(result).not.toBeNull();
    const settledResult = result!;
    expect(settledResult.ok).toBe(false);
    if (settledResult.ok) throw new Error("unreachable");
    expect(settledResult.code).toBe("connection_not_active");
  });
});

describe("a runtime credential speaks only for its own Connection", () => {
  async function credentialFor(
    spaceId: string,
    name: string,
  ): Promise<{ key: string; connectionId: string }> {
    const connectionId = await makeConnection(spaceId, name);
    const res = await mint(connectionId);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return { key: res.api_key, connectionId };
  }

  it("refuses to create activity attributed to a sibling", async () => {
    const space = await ctx.storage.spaces!.create("activity-create");
    const mine = await credentialFor(space.id, "acme/mine");
    const sibling = await credentialFor(space.id, "acme/sibling");

    const res = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "action_required",
          summary: "re-authorize this integration",
        },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses the same write through the bulk door", async () => {
    // Bulk runs the same type gate, so the carve-out that admits
    // `system.activity` admits it here too. Without the attribution
    // check the door is simply wider.
    const space = await ctx.storage.spaces!.create("activity-bulk");
    const mine = await credentialFor(space.id, "acme/bulk-mine");
    const sibling = await credentialFor(space.id, "acme/bulk-sibling");

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            type: "system.activity",
            properties: {
              connection_id: sibling.connectionId,
              severity: "error",
              summary: "sibling is broken",
            },
          },
        ],
      },
    });
    // Atomic mode is the default, so an unauthorized item aborts the
    // batch rather than reporting per-item.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await ctx.storage.items.list({
      type: "system.activity",
      spaceId: space.id,
    });
    expect(rows.data).toHaveLength(0);
  });

  it("refuses to edit a sibling's activity row through the bulk door", async () => {
    // `POST /items/bulk` in upsert mode reaches an existing row two
    // ways, and only one of them is fenced by the credential's own
    // source. Supplying `id` addresses any row in the space directly,
    // so authorizing the body's claims leaves the update judged on what
    // the caller says rather than on what it is about to overwrite —
    // the same intent `PATCH` refuses, through a door that admitted it.
    const space = await ctx.storage.spaces!.create("activity-bulk-patch");
    const mine = await credentialFor(space.id, "acme/bulk-patch-mine");
    const sibling = await credentialFor(space.id, "acme/bulk-patch-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            id: row.id,
            type: "system.activity",
            properties: {
              connection_id: mine.connectionId,
              severity: "action_required",
              summary: "hijacked via bulk",
            },
          },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await ctx.storage.items.get(row.id, space.id);
    expect(after?.properties.connection_id).toBe(sibling.connectionId);
    expect(after?.properties.severity).toBe("info");
    expect(after?.properties.summary).toBe("sync complete");
  });

  it("refuses a bulk update whose claimed type is not the target row's", async () => {
    // The type the batch entry declares is the caller's to choose, and
    // the update path never uses it — the write lands on whatever type
    // the addressed row already is. Authorizing the claim therefore
    // checks a type nothing is about to be written to, and every gate
    // keyed on the real type is skipped: the attribution check never
    // runs because the claimed type is not `system.activity`.
    const space = await ctx.storage.spaces!.create("activity-bulk-type");
    const mine = await credentialFor(space.id, "acme/bulk-type-mine");
    const sibling = await credentialFor(space.id, "acme/bulk-type-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            id: row.id,
            // A type this credential genuinely holds write on, so the
            // claim passes every check that reads it.
            type: "core.note",
            properties: { body: "clobbered" },
          },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await ctx.storage.items.get(row.id, space.id);
    expect(after?.properties.summary).toBe("sync complete");
    expect(after?.properties.body).toBeUndefined();
  });

  it("refuses a bulk update against a type the credential cannot write", async () => {
    // Same claimed-type bypass, aimed at a row whose real type this
    // credential could never write directly. `system.connection` needs a
    // platform credential; naming `core.note` in the batch entry is what
    // used to get past that.
    const space = await ctx.storage.spaces!.create("connection-bulk-type");
    const mine = await credentialFor(space.id, "acme/conn-type-mine");
    const sibling = await credentialFor(space.id, "acme/conn-type-sibling");

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            id: sibling.connectionId,
            type: "core.note",
            properties: { status: "revoked" },
          },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await ctx.storage.items.get(sibling.connectionId, space.id);
    expect(after?.properties.status).toBe("active");
  });

  it("refuses to re-attribute its own activity row through the bulk door", async () => {
    // The post-merge half of the update check, reached past the gate on
    // the entry's own claims: the row starts out this credential's, so
    // nothing about it as it stands is wrong, and the claimed type is
    // not `system.activity`, so the check on the entry never looks at
    // the `connection_id` it carries. Only judging the merged result
    // against the row's real type refuses it.
    const space = await ctx.storage.spaces!.create("activity-bulk-reattr");
    const mine = await credentialFor(space.id, "acme/bulk-reattr-mine");
    const sibling = await credentialFor(space.id, "acme/bulk-reattr-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            id: row.id,
            type: "core.note",
            properties: { connection_id: sibling.connectionId },
          },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await ctx.storage.items.get(row.id, space.id);
    expect(after?.properties.connection_id).toBe(mine.connectionId);
  });

  it("still lets a credential bulk-upsert its own activity row by id", async () => {
    // The fix authorizes against the target row, so the legitimate
    // upsert-by-id path a client takes when it already holds the row's
    // id has to keep working.
    const space = await ctx.storage.spaces!.create("activity-bulk-own");
    const mine = await credentialFor(space.id, "acme/bulk-own");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync started",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            id: row.id,
            type: "system.activity",
            properties: {
              connection_id: mine.connectionId,
              severity: "info",
              summary: "sync complete",
            },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { updated: number };
      results: { outcome: string }[];
    };
    expect(body.counts.updated).toBe(1);
    expect(body.results[0]?.outcome).toBe("updated");

    const after = await ctx.storage.items.get(row.id, space.id);
    expect(after?.properties.summary).toBe("sync complete");
  });

  it("refuses to edit a sibling's activity row", async () => {
    const space = await ctx.storage.spaces!.create("activity-patch");
    const mine = await credentialFor(space.id, "acme/patch-mine");
    const sibling = await credentialFor(space.id, "acme/patch-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    // No `connection_id` in the body at all: the row is not this
    // credential's to touch, whatever the patch says.
    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { severity: "action_required" } },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to claim a sibling's activity row by re-pointing it", async () => {
    // The one case the post-merge check alone cannot catch: the row
    // being edited belongs to a sibling, and the patch names this
    // credential's own connection. Judged on the merged result, that
    // reads as a credential writing its own activity; judged on the row
    // as it stands, it is one integration taking another's.
    const space = await ctx.storage.spaces!.create("activity-claim");
    const mine = await credentialFor(space.id, "acme/claim-mine");
    const sibling = await credentialFor(space.id, "acme/claim-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: {
        properties: {
          connection_id: mine.connectionId,
          summary: "actually mine",
        },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to re-attribute its own activity row to a sibling", async () => {
    const space = await ctx.storage.spaces!.create("activity-reattribute");
    const mine = await credentialFor(space.id, "acme/reattr-mine");
    const sibling = await credentialFor(space.id, "acme/reattr-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { connection_id: sibling.connectionId } },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a natural-key upsert against a type it cannot write", async () => {
    // The third door, and the one clause of its fix that attribution
    // cannot stand in for. `POST /items` short-circuits to an update when
    // `(source, source_id)` resolves a row, and that update ignores the
    // body's `type` entirely — it lands on whatever the resolved row
    // already is. Naming a type the credential does hold therefore
    // admitted an edit to a row of any other type.
    //
    // Reachable because item provenance is now the Connection's rather
    // than the credential's: a source that rotated with each mint could
    // only ever resolve rows from the live generation, so the door
    // matters more after that change than before it. The fixture stands
    // in for a row an earlier generation wrote under a manifest that has
    // since been narrowed — same provenance, a type this credential no
    // longer reaches.
    const space = await ctx.storage.spaces!.create("upsert-target-type");
    const mine = await credentialFor(space.id, "acme/upsert-target-type");

    const legacy = await ctx.storage.items.create(
      {
        type: "core.task",
        properties: { title: "left by an earlier generation" },
        source: "integration:acme/upsert-target-type",
        source_id: "narrowed",
      },
      space.id,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "core.note",
        source_id: "narrowed",
        properties: { body: "clobbered" },
      },
    });
    expect(res.status).toBe(403);

    const after = await ctx.storage.items.get(legacy.id, space.id);
    expect(after?.properties.title).toBe("left by an earlier generation");
    expect(after?.properties.body).toBeUndefined();
  });

  it("still lets a credential write and update its own activity", async () => {
    // The gate has to admit the only thing an integration legitimately does
    // with this type, or the runtime SDK's activity sink stops working
    // on every run and the failure is invisible until nothing reports.
    const space = await ctx.storage.spaces!.create("activity-own");
    const mine = await credentialFor(space.id, "acme/own");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    // A partial patch that never mentions `connection_id` must not be
    // read as claiming an absent one.
    const patched = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { summary: "sync complete (42 items)" } },
    });
    expect(patched.status).toBe(200);
  });
});
