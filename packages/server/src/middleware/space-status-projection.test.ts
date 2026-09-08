/**
 * That the suspension gate actually consults the status guard.
 *
 * `stored-space-status.test.ts` proves the helper projects an unreadable
 * status to `suspended`. It cannot prove the store calls it, and that is
 * the half carrying the security property: delete the call from either
 * dialect's `get`/`getStatus` and every assertion in that file still
 * passes while the gate silently reverts to reading a raw string.
 *
 * So this drives a real write through the real middleware against a value
 * written straight into the database, the way the role-projection tests
 * do for `users.role`.
 *
 * **The cast is the point.** Only `setStatus` writes this column and it
 * takes a typed `SpaceStatus`, so nothing reachable from TypeScript can
 * store a bad one — which is exactly why one can sit in a database
 * unnoticed. Constructing the state needs the type system stepped around
 * deliberately.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "./auth.js";
import { _clearSpaceStatusCacheForTesting } from "./space-suspension.js";
import type { SpaceStatus } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function mintSpaceKey(spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_test_member_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `test-member-${suffix}`,
      source: `test-member-${suffix}`,
      type_permissions: { "core.note": "write" },
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

/**
 * Writes a status the union does not contain, reaching the store's own
 * private setter rather than the database directly so both dialects are
 * exercised by the same test.
 */
async function forceStatus(spaceId: string, status: string): Promise<void> {
  const store = ctx.storage.spaces;
  if (!store) throw new Error("storage missing space store");
  await (
    store as unknown as {
      setStatus(id: string, status: SpaceStatus): Promise<unknown>;
    }
  ).setStatus(spaceId, status as SpaceStatus);
  // The gate caches a space's status for 5s and the admin suspend route
  // is what normally evicts it. Nothing evicted it here, because nothing
  // legitimate wrote this value.
  _clearSpaceStatusCacheForTesting();
}

async function writeNote(key: string): Promise<Response> {
  return request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body: "probe" } },
  });
}

describe("space status projection reaches the suspension gate", () => {
  it("refuses a write when the stored status differs only in case", async () => {
    // The motivating defect. `"Suspended"` failed the gate's single
    // equality, so the space kept accepting writes while an operator
    // believed it was stopped.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("status-case-mismatch");
    const key = await mintSpaceKey(space.id);

    expect((await writeNote(key)).status).toBe(201);

    await forceStatus(space.id, "Suspended");

    const res = await writeNote(key);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("space_suspended");
  });

  it("refuses a write on a status a later build introduced", async () => {
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("status-unknown-value");
    const key = await mintSpaceKey(space.id);

    await forceStatus(space.id, "pending_deletion");

    const res = await writeNote(key);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("space_suspended");
  });

  it("still lets reads through on an unreadable status", async () => {
    // The fallback costs the space its writes and nothing else. This is
    // half of why leaning restrictive is recoverable rather than merely
    // safe.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("status-reads-pass");
    const key = await mintSpaceKey(space.id);

    await forceStatus(space.id, "Suspended");

    const res = await request(ctx.app, "GET", "/items", { key });
    expect(res.status).toBe(200);
  });

  it("does not refuse a space whose status is genuinely active", async () => {
    // The control. Without it every assertion above is satisfied by a
    // guard that suspends every space on the instance, which would pass
    // this file and take down the deployment.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("status-genuinely-active");
    const key = await mintSpaceKey(space.id);

    await forceStatus(space.id, "active");

    expect((await writeNote(key)).status).toBe(201);
  });

  it("recovers through the ordinary unsuspend route", async () => {
    // A wrongly-suspended space must not be stranded, and the repair path
    // must not depend on reading the broken value. `setStatus` is an
    // unconditional UPDATE, so unsuspend overwrites whatever is stored.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("status-recovery");
    const key = await mintSpaceKey(space.id);

    await forceStatus(space.id, "Suspended");
    expect((await writeNote(key)).status).toBe(403);

    const unsuspend = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/unsuspend`,
      { key: ctx.adminKey },
    );
    expect(unsuspend.status).toBe(200);

    expect((await writeNote(key)).status).toBe(201);
  });
});
