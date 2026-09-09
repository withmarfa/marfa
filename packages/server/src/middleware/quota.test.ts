import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  mintSpaceKey,
  request,
  type TestContext,
} from "../test-utils.js";
import type { SpacePermission } from "@withmarfa/shared";

/**
 * A real space, and a working key inside it.
 *
 * A quota is a property of a space, and the count it is compared against is
 * a query over that space's rows, so both halves have to name a space that
 * exists. This file used to mint into an id it made up, which no `spaces`
 * row backed: the counts happened to work because they read the items table
 * rather than the space, and the fixture was one join away from asserting
 * nothing. `mintSpaceKey` is the shared helper, shaped the way `POST
 * /admin/spaces/{id}/keys` shapes a key.
 */
async function spaceWithKey(
  ctx: TestContext,
  label: string,
  spacePermissions?: SpacePermission[],
): Promise<{ spaceId: string; key: string }> {
  const space = await ctx.storage.spaces!.create();
  const key = await mintSpaceKey(ctx, space.id, {
    label,
    ...(spacePermissions !== undefined && {
      space_permissions: spacePermissions,
    }),
  });
  return { spaceId: space.id, key };
}

describe("per-space quota enforcement", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("webhook quota = 2 → third POST returns 429 with quota_exceeded shape", async () => {
    ctx = await createTestContext();
    const { spaceId, key: spaceKey } = await spaceWithKey(
      ctx,
      "quota-webhooks",
      ["space.webhooks"],
    );

    // Set the cap through the storage layer; the instance route that sets
    // one is exercised at the end of this file.
    await ctx.storage.spaceQuotas.set(spaceId, { webhooks_limit: 2 });

    for (let i = 0; i < 2; i++) {
      const ok = await request(ctx.app, "POST", "/webhooks", {
        key: spaceKey,
        body: {
          url: `https://example.com/hook-${String(i)}`,
          events: ["item.created"],
        },
      });
      expect(ok.status).toBe(201);
    }

    const overshoot = await request(ctx.app, "POST", "/webhooks", {
      key: spaceKey,
      body: {
        url: "https://example.com/hook-overshoot",
        events: ["item.created"],
      },
    });
    expect(overshoot.status).toBe(429);
    const body = (await overshoot.json()) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.resource).toBe("webhooks");
    expect(body.error.details.limit).toBe(2);
    expect(body.error.details.current).toBe(2);
  });

  it("items quota = 3 → fourth POST returns 429", async () => {
    ctx = await createTestContext();
    const { spaceId, key: spaceKey } = await spaceWithKey(ctx, "quota-items");

    await ctx.storage.spaceQuotas.set(spaceId, { items_limit: 3 });

    for (let i = 0; i < 3; i++) {
      const ok = await request(ctx.app, "POST", "/items", {
        key: spaceKey,
        body: {
          type: "core.note",
          properties: { body: `n${String(i)}` },
        },
      });
      expect(ok.status).toBe(201);
    }

    const overshoot = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: { type: "core.note", properties: { body: "overshoot" } },
    });
    expect(overshoot.status).toBe(429);
    const body = (await overshoot.json()) as {
      error: { code: string; details: { resource: string; limit: number } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.resource).toBe("items");
    expect(body.error.details.limit).toBe(3);
  });

  /**
   * The reservation is a no-op for a caller with no space, and this file
   * used to assert that through `POST /webhooks` with the space-less
   * credential. There is no such caller at that door any more: the only
   * space-less credential is the operator key, it holds none of the eleven
   * space permissions, and `POST /webhooks` asks for `space.webhooks`. So
   * the door answers before the reservation is ever consulted, and that
   * refusal is what the case asserts now. The space-less branch inside
   * `reserveQuotaForSpace` is still live and still needed, but its callers
   * are the routes that write into a space on somebody else's behalf, not a
   * credential arriving without one.
   */
  it("the operator key is refused at the webhook door before quota is consulted", async () => {
    ctx = await createTestContext();
    await ctx.storage.spaceQuotas.set(ctx.spaceId, { webhooks_limit: 0 });

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.operatorKey,
      body: {
        url: "https://example.com/operator-hook",
        events: ["item.created"],
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  /**
   * Regression for the PG bigint string-concat bug. Before the fix,
   * `space-quota-store.count(spaceId, "storage_bytes")` returned the
   * raw node-postgres bigint as a JS string under PG. The arithmetic
   * `current + increment > limit` then did string concatenation —
   * `"50000" + 1024` became `"500001024"`, which numeric-coerced past
   * any plausible limit and produced a false-positive 429.
   *
   * The test sets a cap, uploads a blob well under it, then uploads a
   * second small blob that should still fit. Pre-fix this 429s under
   * PG; post-fix it succeeds. SQLite path always succeeded (native
   * numbers).
   */
  it("storage_bytes quota arithmetic — second small upload under cap succeeds (PG bigint regression)", async () => {
    ctx = await createTestContext();
    const { spaceId, key: spaceKey } = await spaceWithKey(
      ctx,
      "quota-storage-bytes",
    );

    // Cap = 100_000 bytes (100 KB). First upload ~50 KB; second upload
    // ~1 KB. Sum is ~51 KB, well under the cap. Pre-fix the second
    // upload 429s under PG because "50000" + 1024 = "500001024".
    await ctx.storage.spaceQuotas.set(spaceId, {
      storage_bytes_limit: 100_000,
    });

    const first = new Uint8Array(50_000);
    first.fill(0x41); // distinct content; deduplicates would skew counts
    const firstRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${spaceKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: first,
    });
    expect(firstRes.status).toBe(201);

    const second = new Uint8Array(1_024);
    second.fill(0x42); // different bytes so it doesn't dedupe with the first
    const secondRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${spaceKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: second,
    });
    expect(secondRes.status).toBe(201);

    // Now genuinely overshoot to confirm enforcement still fires when
    // the cap is actually exceeded.
    const overshoot = new Uint8Array(60_000);
    overshoot.fill(0x43);
    const overshootRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${spaceKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: overshoot,
    });
    expect(overshootRes.status).toBe(429);
    const body = (await overshootRes.json()) as {
      error: { code: string; details: { resource: string; current: number } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.resource).toBe("storage_bytes");
    expect(typeof body.error.details.current).toBe("number");
  });

  it("GET / PUT /spaces/:id/quotas — the instance route round-trip", async () => {
    ctx = await createTestContext();
    const space = await ctx.storage.spaces!.create();

    // Initial GET returns null fields
    const initial = await request(
      ctx.app,
      "GET",
      `/spaces/${space.id}/quotas`,
      {
        key: ctx.operatorKey,
      },
    );
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      items_limit: number | null;
    };
    expect(initialBody.items_limit).toBeNull();

    // PUT a quota
    const put = await request(ctx.app, "PUT", `/spaces/${space.id}/quotas`, {
      key: ctx.operatorKey,
      body: { items_limit: 100, webhooks_limit: 5 },
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as {
      items_limit: number;
      webhooks_limit: number;
    };
    expect(putBody.items_limit).toBe(100);
    expect(putBody.webhooks_limit).toBe(5);

    // GET reflects
    const after = await request(ctx.app, "GET", `/spaces/${space.id}/quotas`, {
      key: ctx.operatorKey,
    });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { items_limit: number };
    expect(afterBody.items_limit).toBe(100);
  });
});
