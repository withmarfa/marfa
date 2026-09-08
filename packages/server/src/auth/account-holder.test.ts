import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { isValidId } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  ACCOUNT_HOLDER_TYPE,
  accountHolderSourceId,
  ensureAccountHolderItem,
} from "./account-holder.js";

/**
 * The account holder's graph handle.
 *
 * Without it, "I wrote this" is inexpressible: `assertEdgesCanBeCreated`
 * resolves both endpoints against `items`, and a profile's identity lives in
 * the disjoint `users` id-space, so an `authored-by` aimed at the account
 * holder has no id to carry. Each test below pins one link in the chain that
 * makes it expressible instead.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const SALT = "test-salt";

const isPg = (): boolean => (process.env.DB_DIALECT ?? "sqlite") === "pg";

/** Sign up through the real hosted path so the provisioning hook runs. */
async function signUp(
  c: TestContext,
  email: string,
): Promise<{ authUserId: string; spaceId: string }> {
  const res = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password: "correct horse battery", name: "Test User" },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const authUserId = ((await res.json()) as { user?: { id?: string } }).user
    ?.id;
  expect(authUserId).toBeTruthy();
  const row = await c.storage.users?.getByAuthUserId(authUserId ?? "");
  expect(row?.space_id).toBeTruthy();
  return { authUserId: authUserId ?? "", spaceId: row?.space_id ?? "" };
}

/**
 * Mint a bearer inside a space, granted the whole of the ordinary data plane.
 *
 * The wildcard is deliberately as wide as a space credential can be: the write
 * gate under test is the reserved-namespace one, which reads `is_operator` and
 * never the maps, so a credential that reaches every ordinary type and is
 * still refused here is what makes the refusal mean something.
 */
async function mintKey(storage: Storage, spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_test_${suffix}`;
  await storage.keys.create(
    {
      label: `test-space-key-${suffix}`,
      source: `test-space-key-${suffix}`,
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      // Category 2 is its own axis and a wildcard on the type map does not
      // reach it. A key used to arrive there through its role; with the role
      // gone the map is the only route, so a fixture that reads the profile
      // has to hold it.
      profile_permissions: { "*": "write" },
    },
    hashApiKey(raw, SALT),
    spaceId,
  );
  return raw;
}

async function countHandles(
  storage: Storage,
  spaceId: string,
): Promise<number> {
  const page = await storage.items.list({
    spaceId,
    type: ACCOUNT_HOLDER_TYPE,
    limit: 50,
  });
  return page.data.length;
}

/**
 * Apply the backfill migration for the running dialect against the current
 * schema.
 *
 * The file is read rather than reproduced, so a change to the backfill's logic
 * still has to pass here. Its column name is rewritten in memory because the
 * migration predates the tenant-to-space rename: applied migrations are
 * history and are never edited, and in the real ordering this one runs long
 * before the rename, so it only ever meets a database that still has the old
 * column. Replaying its literal text against a renamed schema tests a
 * situation that cannot occur.
 */
async function runBackfillMigration(storage: Storage): Promise<void> {
  const file = isPg()
    ? "../../drizzle/pg/0072_backfill_account_holder_items.sql"
    : "../../drizzle/sqlite/0059_backfill_account_holder_items.sql";
  const sql = readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/\btenant_id\b/g, "space_id")
    .replace(/\btenants\b/g, "spaces");
  if (isPg()) {
    const s = storage as unknown as {
      __pgClient: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(sql);
  } else {
    const s = storage as unknown as {
      __sqliteRun: (q: string, p: unknown[]) => Promise<{ changes: number }>;
    };
    await s.__sqliteRun(sql, []);
  }
}

describe("account-holder provisioning", () => {
  it("creates exactly one handle for a new account", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-one@example.com");

    expect(await countHandles(ctx.storage, spaceId)).toBe(1);

    const page = await ctx.storage.items.list({
      spaceId,
      type: ACCOUNT_HOLDER_TYPE,
      limit: 50,
    });
    const handle = page.data[0];
    // The natural key is what makes "one per space" a database constraint
    // rather than a convention, so assert the row actually carries it.
    expect(handle?.source).toBe("system");
    expect(handle?.source_id).toBe(accountHolderSourceId(spaceId));
    expect(handle?.state).toBe("active");
    expect(handle?.properties).toEqual({});
    // Route-layer path params are validated against the UUIDv7 grammar; an
    // id that fails it makes the row unreachable and unusable as an edge
    // endpoint, which is the whole point of the row.
    expect(isValidId(handle?.id ?? "")).toBe(true);
  });

  it("does not create a second handle when the same email signs up twice", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-dupe@example.com");
    // Better Auth's no-enumeration sign-up returns the existing user id, so
    // the hook runs a second time against an account that already has one.
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "holder-dupe@example.com",
        password: "correct horse battery",
        name: "Test User",
      },
      headers: { origin: ORIGIN },
    });

    expect(await countHandles(ctx.storage, spaceId)).toBe(1);

    // The hook short-circuits on an existing `users` row, so the assertion
    // above would hold even for a helper that blindly inserted. Drive the
    // helper directly to pin its own idempotency: it must resolve the
    // existing row, not race the unique index for a second one.
    const first = await ensureAccountHolderItem(ctx.storage, spaceId);
    const second = await ensureAccountHolderItem(ctx.storage, spaceId);
    expect(second.id).toBe(first.id);
    expect(await countHandles(ctx.storage, spaceId)).toBe(1);
  });

  it("exposes the handle id on the profile wire shape", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-profile@example.com");
    const key = await mintKey(ctx.storage, spaceId);

    const res = await request(ctx.app, "GET", "/profile/me", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account_holder_item_id?: string };
    const page = await ctx.storage.items.list({
      spaceId,
      type: ACCOUNT_HOLDER_TYPE,
      limit: 50,
    });
    expect(body.account_holder_item_id).toBe(page.data[0]?.id);
  });
});

describe("account-holder edges", () => {
  it("accepts an authored-by edge from a note and hydrates it back out", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-edge@example.com");
    const key = await mintKey(ctx.storage, spaceId);

    const profile = (await (
      await request(ctx.app, "GET", "/profile/me", { key })
    ).json()) as { account_holder_item_id?: string };
    const holderId = profile.account_holder_item_id;
    expect(holderId).toBeTruthy();

    const noteRes = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "I wrote this" } },
    });
    expect(noteRes.status).toBe(201);
    const noteId = ((await noteRes.json()) as { item: { id: string } }).item.id;

    const edgeRes = await request(ctx.app, "POST", "/edges", {
      key,
      body: {
        source_id: noteId,
        target_id: holderId,
        edge_type: "authored-by",
      },
    });
    expect(edgeRes.status).toBe(201);

    // A write that lands but does not read back is not a usable edge.
    const readRes = await request(ctx.app, "GET", `/items/${noteId}`, { key });
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as {
      item: {
        edges?: Record<string, { edges: { target_id: string }[] }>;
      };
    };
    expect(read.item.edges?.["authored-by"]?.edges[0]?.target_id).toBe(
      holderId,
    );

    // The inbound direction is the one the handle exists for — "what did
    // this person write" walks the holder's backrefs, and nothing else
    // asserted it.
    const backrefsRes = await request(
      ctx.app,
      "GET",
      `/items/${String(holderId)}/backrefs?edge_type=authored-by`,
      { key },
    );
    expect(backrefsRes.status).toBe(200);
    const backrefs = (await backrefsRes.json()) as {
      data: { source_id: string; target_id: string }[];
    };
    const inbound = backrefs.data.find((e) => e.source_id === noteId);
    expect(inbound).toBeDefined();
    expect(inbound?.target_id).toBe(holderId);
  });

  it("rejects the same edge when the space has no handle", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-unfixed@example.com");
    const key = await mintKey(ctx.storage, spaceId);

    const profile = (await (
      await request(ctx.app, "GET", "/profile/me", { key })
    ).json()) as { account_holder_item_id?: string };
    const holderId = profile.account_holder_item_id ?? "";

    // Reproduce the pre-fix state: a space provisioned without a handle.
    // The id is kept so the edge attempt is identical to the one above.
    // `bulkPurge` rather than `purge` because the single-item path requires
    // a trashed row, and `trashed` is not reachable on the bounded
    // `system.*` lifecycle.
    await ctx.storage.items.bulkPurge([holderId], spaceId);

    const noteRes = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "I wrote this" } },
    });
    const noteId = ((await noteRes.json()) as { item: { id: string } }).item.id;

    const edgeRes = await request(ctx.app, "POST", "/edges", {
      key,
      body: {
        source_id: noteId,
        target_id: holderId,
        edge_type: "authored-by",
      },
    });
    expect(edgeRes.status).toBe(404);
    expect(
      ((await edgeRes.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("item_not_found");

    // And the profile stops advertising an id that resolves to nothing,
    // rather than handing clients a dangling target.
    const after = (await (
      await request(ctx.app, "GET", "/profile/me", { key })
    ).json()) as { account_holder_item_id?: string };
    expect(after.account_holder_item_id).toBeUndefined();
  });
});

describe("account-holder backfill migration", () => {
  it("creates exactly one handle per existing space and is re-runnable", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const spaces = ctx.storage.spaces;
    expect(spaces).toBeTruthy();

    // Two spaces that predate the provisioning hook, plus one that already
    // has its handle: the guard has to skip the third without duplicating it.
    const older = await spaces!.create("Older Space");
    const oldest = await spaces!.create("Oldest Space");
    const current = await spaces!.create("Current Space");
    const alreadyProvisioned = await ensureAccountHolderItem(
      ctx.storage,
      current.id,
    );

    await runBackfillMigration(ctx.storage);

    for (const spaceId of [older.id, oldest.id, current.id]) {
      expect(await countHandles(ctx.storage, spaceId)).toBe(1);
    }
    const backfilled = await ctx.storage.items.list({
      spaceId: older.id,
      type: ACCOUNT_HOLDER_TYPE,
      limit: 50,
    });
    const row = backfilled.data[0];
    expect(isValidId(row?.id ?? "")).toBe(true);
    expect(row?.source_id).toBe(accountHolderSourceId(older.id));
    expect(row?.state).toBe("active");

    // The pre-existing row is left alone, not rewritten under a new id.
    const currentAfter = await ctx.storage.items.list({
      spaceId: current.id,
      type: ACCOUNT_HOLDER_TYPE,
      limit: 50,
    });
    expect(currentAfter.data[0]?.id).toBe(alreadyProvisioned.id);

    // Re-runnable: a second application adds nothing.
    await runBackfillMigration(ctx.storage);
    for (const spaceId of [older.id, oldest.id, current.id]) {
      expect(await countHandles(ctx.storage, spaceId)).toBe(1);
    }
  });
});

describe("account-holder lifecycle", () => {
  it("is removed with its edges when the account is deleted", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { authUserId, spaceId } = await signUp(
      ctx,
      "holder-delete@example.com",
    );
    const key = await mintKey(ctx.storage, spaceId);

    const profile = (await (
      await request(ctx.app, "GET", "/profile/me", { key })
    ).json()) as { account_holder_item_id?: string };
    const holderId = profile.account_holder_item_id ?? "";

    const noteId = (
      (await (
        await request(ctx.app, "POST", "/items", {
          key,
          body: { type: "core.note", properties: { body: "Mine" } },
        })
      ).json()) as { item: { id: string } }
    ).item.id;
    await request(ctx.app, "POST", "/edges", {
      key,
      body: {
        source_id: noteId,
        target_id: holderId,
        edge_type: "authored-by",
      },
    });
    expect((await ctx.storage.edges.listToTarget(holderId)).data.length).toBe(
      1,
    );

    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    await lifecycle!.markPendingDeletion(authUserId, new Date().toISOString());
    const cutoff = new Date(Date.now() + 86_400_000).toISOString();
    expect(await ctx.storage.deleteAccountCascade(authUserId, cutoff)).toBe(
      true,
    );

    expect(await ctx.storage.items.getIncludingTrashed(holderId)).toBeNull();
    expect((await ctx.storage.edges.listToTarget(holderId)).data.length).toBe(
      0,
    );
  });
});

describe("account-holder write gate", () => {
  it("refuses create, update and delete from an ordinary space credential", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { spaceId } = await signUp(ctx, "holder-gate@example.com");
    const spaceKey = await mintKey(ctx.storage, spaceId);

    const page = await ctx.storage.items.list({
      spaceId,
      type: ACCOUNT_HOLDER_TYPE,
      limit: 50,
    });
    const holderId = page.data[0]?.id ?? "";

    // A wildcard `type_permissions` grant is deliberately not enough: the
    // reserved-namespace gate runs ahead of the permission maps.
    const create = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: { type: ACCOUNT_HOLDER_TYPE, properties: {} },
    });
    expect(create.status).toBe(403);
    expect(
      ((await create.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("type_not_permitted");

    const patch = await request(ctx.app, "PATCH", `/items/${holderId}`, {
      key: spaceKey,
      body: { properties: { spoofed: true } },
    });
    expect(patch.status).toBe(403);

    const del = await request(ctx.app, "DELETE", `/items/${holderId}`, {
      key: spaceKey,
    });
    expect(del.status).toBe(403);

    // The row is untouched by all three attempts.
    expect(await countHandles(ctx.storage, spaceId)).toBe(1);
  });
});
