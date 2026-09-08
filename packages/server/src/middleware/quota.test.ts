import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "./auth.js";
import type { SpacePermission } from "@withmarfa/shared";

async function mintSpaceKey(
  ctx: TestContext,
  spaceId: string,
  label: string,
  spacePermissions: SpacePermission[] = [],
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_quota_test_${suffix}`;
  // Grant `*: write` explicitly so the test can exercise items.create.
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      space_permissions: spacePermissions,
      default_tier: "library",
      type_permissions: { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

describe("per-space quota enforcement", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("webhook quota = 2 → third POST returns 429 with quota_exceeded shape", async () => {
    ctx = await createTestContext();
    const spaceId = `space-${Math.random().toString(36).slice(2, 10)}`;
    const adminKey = await mintSpaceKey(ctx, spaceId, "wh-quota-admin", [
      "space.webhooks",
    ]);

    // Set the cap via the storage layer directly (admin route is also
    // exercised below).
    await ctx.storage.spaceQuotas.set(spaceId, { webhooks_limit: 2 });

    for (let i = 0; i < 2; i++) {
      const ok = await request(ctx.app, "POST", "/webhooks", {
        key: adminKey,
        body: {
          url: `https://example.com/hook-${String(i)}`,
          events: ["item.created"],
        },
      });
      expect(ok.status).toBe(201);
    }

    const overshoot = await request(ctx.app, "POST", "/webhooks", {
      key: adminKey,
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
    const spaceId = `space-${Math.random().toString(36).slice(2, 10)}`;
    const adminKey = await mintSpaceKey(ctx, spaceId, "items-quota-admin");

    await ctx.storage.spaceQuotas.set(spaceId, { items_limit: 3 });

    for (let i = 0; i < 3; i++) {
      const ok = await request(ctx.app, "POST", "/items", {
        key: adminKey,
        body: {
          type: "core.note",
          properties: { body: `n${String(i)}` },
        },
      });
      expect(ok.status).toBe(201);
    }

    const overshoot = await request(ctx.app, "POST", "/items", {
      key: adminKey,
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

  it("space-less platform admin bypasses quota enforcement entirely", async () => {
    ctx = await createTestContext();
    // Set a quota for an arbitrary space — irrelevant here because the
    // bootstrap admin (ctx.adminKey) has no space_id.
    await ctx.storage.spaceQuotas.set("phantom-space", { webhooks_limit: 0 });

    // Platform admin can create webhooks freely; they don't have a
    // space_id, so enforceQuota is a no-op.
    for (let i = 0; i < 3; i++) {
      const res = await request(ctx.app, "POST", "/webhooks", {
        key: ctx.adminKey,
        body: {
          url: `https://example.com/admin-hook-${String(i)}`,
          events: ["item.created"],
        },
      });
      expect(res.status).toBe(201);
    }
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
    const spaceId = `space-${Math.random().toString(36).slice(2, 10)}`;
    const adminKey = await mintSpaceKey(ctx, spaceId, "storage-bytes-admin");

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
        Authorization: `Bearer ${adminKey}`,
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
        Authorization: `Bearer ${adminKey}`,
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
        Authorization: `Bearer ${adminKey}`,
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

  it("GET / PUT /spaces/:id/quotas — admin round-trip", async () => {
    ctx = await createTestContext();
    const space = await ctx.storage.spaces!.create();

    // Initial GET returns null fields
    const initial = await request(
      ctx.app,
      "GET",
      `/spaces/${space.id}/quotas`,
      {
        key: ctx.adminKey,
      },
    );
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      items_limit: number | null;
    };
    expect(initialBody.items_limit).toBeNull();

    // PUT a quota
    const put = await request(ctx.app, "PUT", `/spaces/${space.id}/quotas`, {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
    });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { items_limit: number };
    expect(afterBody.items_limit).toBe(100);
  });
});
