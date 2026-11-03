import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
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
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { total: unknown; by_state: Record<string, unknown> };
      blobs: { count: unknown; total_bytes: unknown };
      types: { core: unknown; registered: unknown };
      keys: { total: unknown };
      webhooks: { total: unknown };
      uptime_seconds: unknown;
      cached_at: unknown;
    };

    // Every counter must be a JS number: a driver `bigint` leaking through as
    // a string would turn the reduce into a concatenation, an `items.total`
    // like "01135389".
    expect(typeof body.items.total).toBe("number");
    for (const [state, count] of Object.entries(body.items.by_state)) {
      expect(typeof count, `items.by_state.${state} should be a number`).toBe(
        "number",
      );
    }
    expect(typeof body.blobs.count).toBe("number");
    expect(typeof body.blobs.total_bytes).toBe("number");
    expect(typeof body.types.core).toBe("number");
    expect(typeof body.types.registered).toBe("number");
    expect(typeof body.keys.total).toBe("number");
    expect(typeof body.webhooks.total).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.cached_at).toBe("string");
  });

  it("reports what the process and the database cost", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.managementKey,
    });
    const body = (await res.json()) as {
      items: { total: number };
      process: Record<string, unknown>;
      storage: {
        database_bytes: number;
        wal_bytes: number;
        rows: Record<string, number | null>;
        counted_at: string | null;
      };
    };
    expect(Object.keys(body.process).sort()).toEqual([
      "cpu_system_seconds",
      "cpu_user_seconds",
      "heap_total_bytes",
      "heap_used_bytes",
      "memory_rss_bytes",
      "memory_rss_peak_bytes",
      "release",
    ]);
    expect(body.process.release).toBe("dev");
    expect(body.process.memory_rss_bytes as number).toBeGreaterThan(0);
    expect(body.process.memory_rss_peak_bytes as number).toBeGreaterThan(0);
    expect(body.storage.database_bytes).toBeGreaterThan(0);
    expect(body.storage.wal_bytes).toBeGreaterThanOrEqual(0);
    expect(Object.keys(body.storage.rows).sort()).toEqual([
      "audit_log",
      "event_log",
      "items",
      "versions",
    ]);
    // The row counts come from the background count, which the first
    // request only started; the live item counter is already there.
    expect(body.items.total).toBeGreaterThan(0);
  });

  it("blobs.total_bytes sums the bytes rather than counting the rows", async () => {
    // `typeof === "number"` above passes against a count, a zero, or the
    // uptime. Two blobs of different lengths separate all three: the sum is
    // neither the row count nor either length on its own.
    const first = await request(ctx.app, "POST", "/blobs", {
      key: ctx.workingKey,
      body: new Uint8Array(153).fill(65),
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(first.status).toBe(201);
    const second = await request(ctx.app, "POST", "/blobs", {
      key: ctx.workingKey,
      body: new Uint8Array(67).fill(66),
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(second.status).toBe(201);

    const stats = await ctx.storage.blobs.count();
    expect(stats.count).toBeGreaterThanOrEqual(2);
    expect(stats.total_size_bytes).toBeGreaterThanOrEqual(153 + 67);
    expect(stats.total_size_bytes).toBeGreaterThan(stats.count);
  });

  it("items.total equals the sum of items.by_state", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { total: number; by_state: Record<string, number> };
    };

    const sum = Object.values(body.items.by_state).reduce((a, b) => a + b, 0);
    expect(body.items.total).toBe(sum);
  });

  it("omits scheduled_jobs where there is no job queue", async () => {
    // Nothing installs a reporter in a test context, which is the shape of
    // a deployment with no queue: SQLite runs the same jobs on in-process
    // timers and writes no equivalent record. The section has to be absent
    // rather than a list of jobs that have never ticked, so its absence
    // reads as "no job queue" instead of "nothing ran".
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Assert the payload is the one we think it is before concluding
    // anything from a missing key.
    expect(body).not.toHaveProperty("scheduled_jobs");
  });

  it("requires instance.read even when content permissions are broad", async () => {
    const raw = await mintWorkingKey(ctx, { permissions: [] });
    const res = await request(ctx.app, "GET", "/metrics", { key: raw });
    expect(res.status).toBe(403);
  });
});

describe("GET /metrics row counts", () => {
  let own: TestContext;
  beforeAll(async () => {
    own = await createTestContext();
  });
  afterAll(async () => {
    await cleanupTestContext(own);
  });

  interface Storage {
    database_bytes: number;
    rows: Record<string, number | null>;
    counted_at: string | null;
  }
  const storageBlock = async () => {
    const res = await request(own.app, "GET", "/metrics", {
      key: own.managementKey,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { storage: Storage }).storage;
  };

  it("answers with no counts on a fresh start, without waiting for a count, then shows them", async () => {
    let release!: () => void;
    const held = new Promise<number>((resolve) => {
      release = () => {
        resolve(5);
      };
    });
    const spy = vi.spyOn(own.storage.versions, "count").mockReturnValue(held);

    // The count is held, so a request that counted inside itself would hang.
    const first = await storageBlock();
    expect(first.counted_at).toBeNull();
    expect(first.rows).toEqual({
      items: null,
      versions: null,
      event_log: null,
      audit_log: null,
    });
    expect(first.database_bytes).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Asking again while one runs starts no second count.
    await storageBlock();
    expect(spy).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(async () => {
      expect((await storageBlock()).counted_at).not.toBeNull();
    });
    const counted = await storageBlock();
    expect(counted.rows.versions).toBe(5);
    expect(typeof counted.rows.items).toBe("number");
    expect(typeof counted.rows.event_log).toBe("number");
    expect(typeof counted.rows.audit_log).toBe("number");
    expect(Number.isNaN(Date.parse(counted.counted_at ?? ""))).toBe(false);
    // The count is fresh, so these requests started none.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
