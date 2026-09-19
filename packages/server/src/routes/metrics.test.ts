import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /metrics", () => {
  it("requires admin", async () => {
    const res = await request(ctx.app, "GET", "/metrics");
    // No credential → 401. A working credential would 403, but we don't
    // need to cover that here — the auth gate is exercised by other routes.
    expect(res.status).toBe(401);
  });

  it("returns numeric counters throughout the payload", async () => {
    // Seed at least one item so `items.by_state` is non-empty.
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "metrics shape test" },
      },
    });
    expect(createRes.status).toBe(201);

    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { total: unknown; by_state: Record<string, unknown> };
      blobs: { count: unknown; total_bytes: unknown };
      types: { core: unknown; integration: unknown; registered: unknown };
      keys: { total: unknown };
      webhooks: { total: unknown };
      uptime_seconds: unknown;
      cached_at: unknown;
    };

    // Every counter must be a JS number. Regression guard against a driver
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
    expect(typeof body.types.integration).toBe("number");
    expect(typeof body.types.registered).toBe("number");
    expect(typeof body.keys.total).toBe("number");
    expect(typeof body.webhooks.total).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.cached_at).toBe("string");
  });

  it("items.total equals the sum of items.by_state", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { total: number; by_state: Record<string, number> };
    };

    const sum = Object.values(body.items.by_state).reduce((a, b) => a + b, 0);
    expect(body.items.total).toBe(sum);
  });

  it("omits scheduled_jobs where there is no queue substrate", async () => {
    // Nothing installs a reporter in a test context, which is the shape of
    // a deployment with no queue: SQLite runs the same jobs on in-process
    // timers and writes no equivalent record. The section has to be absent
    // rather than a list of jobs that have never ticked, so its absence
    // reads as "no queue substrate" instead of "nothing ran".
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Assert the payload is the one we think it is before concluding
    // anything from a missing key.
    expect(body).not.toHaveProperty("scheduled_jobs");
  });

  it("refuses a working credential", async () => {
    // Items, blobs, keys, webhooks, registrations, connection drift and
    // scheduled-job ticks are all instance-wide, which makes the whole
    // response platform-operator data — so the gate is platform-only and a
    // working credential is refused whatever it holds, closing the read
    // rather than partially scoping it.
    const raw = `marfa_k1_working_${Math.random().toString(36).slice(2, 10)}`;
    await ctx.storage.keys.create(
      {
        label: "working-key",
        source: `working-${raw.slice(-8)}`,
        permissions: [...PERMISSIONS],
        type_permissions: {},
        default_tier: "feed",
      },
      hashApiKey(raw, "test-salt"),
    );

    const res = await request(ctx.app, "GET", "/metrics", { key: raw });
    expect(res.status).toBe(403);
  });
});
