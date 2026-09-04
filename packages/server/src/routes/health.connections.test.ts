/**
 * `/health`'s database-connection reading, against a real Postgres.
 *
 * The figure comes from `pg_stat_activity` rather than from the driver, so
 * a fake proves nothing here: the value of the test is that the query is
 * accepted by a real server, that the ceiling it reports is the cluster's
 * own `max_connections`, and that this server's own pools are attributed to
 * a named client rather than folded in with everything else.
 *
 * SQLite has no pool and no `pg_stat_activity`, so the block is absent
 * there — asserted in `health.test.ts` alongside the other fake-backed
 * cases.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, TEST_POOL_SIZE } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

const isPg = process.env.DB_DIALECT === "pg";

/** What the test harness's pool stamps. It passes `pgApplicationName` with
 *  no role, matching the `AppConfig` the health routes are built with, so
 *  this is the label the endpoint looks for. */
const APP_POOL = "marfa-both:app";

interface ConnectionsBody {
  database_connections?: {
    total: number;
    ceiling: number;
    max_connections: number;
    reserved: number;
    clients: Record<string, Record<string, number>>;
    pool?: {
      size: number;
      in_use: number;
      idle_in_transaction: number;
      free: number;
    };
  };
  components: { database?: { status: string } };
}

describe.skipIf(!isPg)("GET /health database connections", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("reports this deployment's usage against the cluster ceiling", async () => {
    const res = await request(ctx.app, "GET", "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConnectionsBody;

    const conns = body.database_connections;
    expect(conns).toBeDefined();
    if (!conns) return;

    // The connection running the query is itself in the reading, so a total
    // of zero would mean the query saw nothing at all.
    expect(conns.total).toBeGreaterThan(0);
    expect(conns.ceiling).toBeGreaterThan(0);
    expect(conns.total).toBeLessThanOrEqual(conns.ceiling);

    // The ceiling is what an ordinary client can actually reach, not the
    // advertised maximum. On the managed tier those differ by three, and
    // alerting on the larger one fires after exhaustion rather than before.
    expect(conns.max_connections).toBeGreaterThanOrEqual(conns.ceiling);
    expect(conns.ceiling).toBe(conns.max_connections - conns.reserved);
    expect(conns.reserved).toBeGreaterThanOrEqual(0);

    // Every bucket's states must sum back to the total, or the attribution
    // is dropping connections the total counted.
    const summed = Object.values(conns.clients)
      .flatMap((byState) => Object.values(byState))
      .reduce((a, b) => a + b, 0);
    expect(summed).toBe(conns.total);
  });

  it("names this server's own pools rather than bucketing them as other", async () => {
    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as ConnectionsBody;
    const keys = Object.keys(body.database_connections?.clients ?? {});

    // The app pool is what serves this very request, so it is always open.
    expect(keys.some((k) => /^marfa(-[a-z]+)?:app$/.test(k))).toBe(true);
    // Anything not this server's is folded into one bucket, never published
    // under its own label.
    expect(
      keys.every(
        (k) => k === "other" || /^marfa(-[a-z]+)?:(app|session|lock)$/.test(k),
      ),
    ).toBe(true);
  });

  it("attributes this process's own pool, against the size it was built with", async () => {
    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as ConnectionsBody;
    const pool = body.database_connections?.pool;

    expect(pool).toBeDefined();
    if (!pool) return;

    // The size the test context actually builds its pool with. A pool
    // reported against the production default would read as roomy whatever
    // it was holding, which is the failure this figure exists to prevent.
    expect(pool.size).toBe(TEST_POOL_SIZE);

    // The reading runs on the app pool, so its own backend is in this
    // bucket and `active` while the query executes. `clients` shows it,
    // because that block describes the database as it is; the pool tally
    // must not, because a constant one added to every reading a process
    // takes of itself is the instrument's own weight rather than
    // occupancy — and on a pool of three it is a third of the range.
    //
    // Asserted as the exact difference rather than as a bound, because
    // that is what proves `pg_backend_pid()` actually matched: a query
    // that excluded nothing, and one that excluded everything, both
    // satisfy an inequality.
    const own = body.database_connections?.clients[APP_POOL] ?? {};
    const nonIdle = Object.entries(own)
      .filter(([state]) => state !== "idle")
      .reduce((sum, [, count]) => sum + count, 0);
    expect(nonIdle).toBeGreaterThan(0);
    expect(pool.in_use).toBe(nonIdle - 1);

    expect(pool.idle_in_transaction).toBeLessThanOrEqual(pool.in_use);
    expect(pool.free).toBe(Math.max(0, pool.size - pool.in_use));

    // The component says nothing about occupancy — the probe answered, which
    // is the whole question it asks. Asserted here rather than only against
    // fakes because this is the path where the figures come from a real
    // `pg_stat_activity`, so it is the one that would catch the reading being
    // wired back into the status.
    expect(body.components.database?.status).toBe("ok");
  });

  it("serves the reading from cache rather than probing per request", async () => {
    const first = (await (
      await request(ctx.app, "GET", "/health")
    ).json()) as ConnectionsBody;
    const second = (await (
      await request(ctx.app, "GET", "/health")
    ).json()) as ConnectionsBody;

    // Two calls inside the cache window return the identical object, which
    // is the observable difference between a cached reading and a fresh
    // probe taking a pool slot per health check.
    expect(second.database_connections).toEqual(first.database_connections);
  });
});
