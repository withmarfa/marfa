import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("GET /metrics", () => {
  it("requires admin", async () => {
    const res = await request(ctx.app, "GET", "/metrics");
    // No credential → 401. A non-admin credential would 403, but we don't
    // need to cover that here — the auth gate is exercised by other routes.
    expect(res.status).toBe(401);
  });

  it("returns numeric counters throughout the payload", async () => {
    // Seed at least one item so `items.by_state` is non-empty.
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "metrics shape test" },
      },
    });
    expect(createRes.status).toBe(201);

    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { total: unknown; by_state: Record<string, unknown> };
      blobs: { count: unknown; total_bytes: unknown };
      types: { core: unknown; custom: unknown };
      keys: { total: unknown };
      webhooks: { total: unknown };
      uptime_seconds: unknown;
      cached_at: unknown;
    };

    // Every counter must be a JS number. Regression guard against Postgres
    // `bigint` leaking through as a string (which historically produced a
    // string-concat `items.total` like "01135389" in the reduce).
    expect(typeof body.items.total).toBe("number");
    for (const [state, count] of Object.entries(body.items.by_state)) {
      expect(typeof count, `items.by_state.${state} should be a number`).toBe(
        "number",
      );
    }
    expect(typeof body.blobs.count).toBe("number");
    expect(typeof body.blobs.total_bytes).toBe("number");
    expect(typeof body.types.core).toBe("number");
    expect(typeof body.types.custom).toBe("number");
    expect(typeof body.keys.total).toBe("number");
    expect(typeof body.webhooks.total).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.cached_at).toBe("string");
  });

  it("items.total equals the sum of items.by_state", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { total: number; by_state: Record<string, number> };
    };

    const sum = Object.values(body.items.by_state).reduce((a, b) => a + b, 0);
    expect(body.items.total).toBe(sum);
  });

  it("does not leak one tenant's cached metrics to another tenant", async () => {
    // Create two admin credentials scoped to distinct tenants and seed a
    // different number of items under each. The cache is supposed to be
    // per-tenant, so tenant A's counts must never appear in tenant B's
    // response within the cache TTL.
    const rawA = `myme_k1_tenant_a_${Math.random().toString(36).slice(2, 10)}`;
    const rawB = `myme_k1_tenant_b_${Math.random().toString(36).slice(2, 10)}`;
    await ctx.storage.keys.create(
      {
        label: "tenant-a-admin",
        source: `tenant-a-${rawA.slice(-8)}`,
        role: "admin",
        type_permissions: {},
        default_tier: "feed",
      },
      hashApiKey(rawA, "test-salt"),
      "tenant-a",
    );
    await ctx.storage.keys.create(
      {
        label: "tenant-b-admin",
        source: `tenant-b-${rawB.slice(-8)}`,
        role: "admin",
        type_permissions: {},
        default_tier: "feed",
      },
      hashApiKey(rawB, "test-salt"),
      "tenant-b",
    );

    // Seed 3 items under tenant A, 0 under tenant B (beyond any existing).
    for (let i = 0; i < 3; i++) {
      const res = await request(ctx.app, "POST", "/items", {
        key: rawA,
        body: {
          type: "core.note",
          properties: { body: `a-${String(i)}` },
        },
      });
      expect(res.status).toBe(201);
    }

    // Hit tenant A first to populate its cache entry.
    const aRes = await request(ctx.app, "GET", "/metrics", { key: rawA });
    expect(aRes.status).toBe(200);
    const aBody = (await aRes.json()) as {
      items: { total: number };
    };
    expect(aBody.items.total).toBeGreaterThanOrEqual(3);

    // Tenant B's response must NOT be served from tenant A's cache.
    const bRes = await request(ctx.app, "GET", "/metrics", { key: rawB });
    expect(bRes.status).toBe(200);
    const bBody = (await bRes.json()) as {
      items: { total: number };
    };
    // Tenant B has no items of its own.
    expect(bBody.items.total).toBe(0);
  });
});
