/**
 * The catch-up read must be index-served, verified by reading the query
 * plan rather than by reasoning about it.
 *
 * A resuming client issues this read on every reconnect, and it is the one
 * read whose cost grows with the corpus rather than with what changed. An
 * index that answers the predicate but not the order leaves a sort behind,
 * which is the expensive half and the half no assertion about returned
 * rows can see. The enrichment candidate query shipped as a full scan plus
 * a sort behind a comment claiming otherwise, which is why this is checked
 * by asking the database.
 *
 * Both dialects, and **both auth modes**, because they issue different
 * queries and the difference decided the index. `AUTH_MODE=hosted` binds a
 * space, so the read carries `space_id = ?`; `AUTH_MODE=keys` — the
 * default, and every self-host — binds no space at all. A space-leading
 * composite was written first and this file refused it: with nothing
 * constraining the leading column the planner would not walk it for the
 * ordering, and the space-less case came back `SCAN items` plus
 * `USE TEMP B-TREE FOR ORDER BY`, which is the plan the index exists to
 * prevent. Leading on `updated_at` serves both, so both are asserted here
 * and neither may regress alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { SqliteItemStore } from "./sqlite/item-store.js";
import { SqliteEdgeStore } from "./sqlite/edge-store.js";
import { SCHEMA_SQL } from "./sqlite/schema-sql.generated.js";
import { PgItemStore } from "./pg/item-store.js";
import { PgEdgeStore } from "./pg/edge-store.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function capturingLogger(into: CapturedQuery[]) {
  return {
    logQuery(sql: string, params: unknown[]) {
      into.push({ sql, params });
    },
  };
}

const CURSOR = "2026-01-01T00:00:00.000Z";
const SPACE = "space-plan-probe";

describe("sqlite catch-up plan", () => {
  let client: ReturnType<typeof createClient>;
  let captured: CapturedQuery[];
  let db: ReturnType<typeof drizzleSqlite>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.executeMultiple(SCHEMA_SQL);

    // Rows first, then ANALYZE. An empty table carries no statistics, so
    // the planner falls back to heuristics and will happily pick an index
    // that narrows the predicate and then sorts — which is the plan this
    // file exists to refuse, reached for a reason that says nothing about
    // the index being tested. Seeding across two spaces is what makes the
    // choice between "narrow by space, then sort" and "walk in order"
    // a real one.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) {
      const space = i % 2 === 0 ? SPACE : "space-other";
      // Mixed, matching the Postgres arm. A corpus in which nothing is
      // trashed is not one a catch-up read ever meets, and on the other
      // dialect a uniform value in this column collapses the estimate.
      const state = i % 5 === 0 ? "trashed" : "active";
      const stamp = `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
      rows.push(
        `INSERT INTO items (id, space_id, type, state, tier, properties, created_at, updated_at, timestamp, version) VALUES ('i${String(i)}', '${space}', 'core.note', '${state}', 'library', '{}', '${stamp}', '${stamp}', '${stamp}', 1);`,
        `INSERT INTO edges (id, space_id, source_id, target_id, edge_type, properties, created_at, updated_at) VALUES ('e${String(i)}', '${space}', 'i${String(i)}', 'i${String((i + 1) % 400)}', 'references', '{}', '${stamp}', '${stamp}');`,
      );
    }
    await client.executeMultiple(rows.join("\n"));
    await client.execute("ANALYZE");

    captured = [];
    db = drizzleSqlite(client, { logger: capturingLogger(captured) });
  });

  afterAll(() => {
    client.close();
  });

  async function planOf(run: () => Promise<unknown>): Promise<string> {
    captured.length = 0;
    await run();
    const query = captured.at(-1);
    expect(query).toBeDefined();
    // Explain the parameterized statement as-is. SQLite plans at prepare
    // time, before any value is bound, so substituting the params first
    // would show a plan production never gets.
    const plan = await client.execute(
      `EXPLAIN QUERY PLAN ${query!.sql}`,
      query!.params as never[],
    );
    return plan.rows
      .map((r) => String((r as Record<string, unknown>).detail))
      .join("\n");
  }

  it("walks the index for a space-bound read, with no sort", async () => {
    const store = new SqliteItemStore(
      db as never,
      null as never,
      null as never,
    );
    const detail = await planOf(() =>
      store.list({ spaceId: SPACE, updated_after: CURSOR, limit: 50 }),
    );
    expect(detail).toContain("idx_items_updated_at_id");
    // The half an index on the predicate alone would not buy. A temporary
    // b-tree here means every catch-up sorts the corpus it matched.
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("walks the index for a space-less read, with no sort", async () => {
    // `AUTH_MODE=keys` is the default and binds no space, so this is the
    // shape every self-hosted deployment issues.
    const store = new SqliteItemStore(
      db as never,
      null as never,
      null as never,
    );
    const detail = await planOf(() =>
      store.list({ updated_after: CURSOR, limit: 50 }),
    );
    expect(detail).toContain("idx_items_updated_at_id");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("walks the index for the edge half", async () => {
    const store = new SqliteEdgeStore(db as never);
    const detail = await planOf(() =>
      store.list({ spaceId: SPACE, updated_after: CURSOR, limit: 50 }),
    );
    expect(detail).toContain("idx_edges_updated_at_id");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

const isPg = process.env.DB_DIALECT === "pg";

describe.skipIf(!isPg)("postgres catch-up plan", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();

    // This arm shipped with no seed at all and read as a product failure:
    // the plans came back as a scan plus a sort, which is what this file
    // exists to refuse. An unanalysed table is only half of why.
    //
    // The other half is `state`, and it is the part worth writing down.
    // The read filters `state <> 'trashed'`, and under a forced generic
    // plan the planner cannot see the bound value, so it works from the
    // column's statistics alone. Seed every row `active` and ANALYZE
    // records one distinct value at frequency 1.0, from which `<>` is
    // estimated to match nothing, clamped up to the floor of one row — and
    // a scan of a table believed to hold one row is cheapest at any size.
    // Measured across both variables rather than assumed: uniform `state`
    // gives a scan plus a sort at 400, 2000, 10000 and 50000 rows with the
    // estimate pinned at 1 throughout, while a mixed `state` walks the
    // index at all four with the estimate tracking the corpus. **The
    // corpus size is not the discriminator here; the column's distribution
    // is**, so seeding more rows would never have fixed it.
    const client = ctx.storage.pgClient as Sql;
    const items: string[] = [];
    const edges: string[] = [];
    for (let i = 0; i < 400; i++) {
      const space = i % 2 === 0 ? SPACE : "space-other";
      // A fifth trashed, so the filtered column has a real distribution.
      const state = i % 5 === 0 ? "trashed" : "active";
      const stamp = `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
      items.push(
        `('i${String(i)}', '${space}', 'core.note', '${state}', 'library', '{}', '${stamp}', '${stamp}', '${stamp}', 1)`,
      );
      edges.push(
        `('e${String(i)}', '${space}', 'i${String(i)}', 'i${String((i + 1) % 400)}', 'references', '{}', '${stamp}', '${stamp}')`,
      );
    }
    await client.unsafe(
      `INSERT INTO items (id, space_id, type, state, tier, properties, created_at, updated_at, timestamp, version) VALUES ${items.join(", ")}`,
    );
    await client.unsafe(
      `INSERT INTO edges (id, space_id, source_id, target_id, edge_type, properties, created_at, updated_at) VALUES ${edges.join(", ")}`,
    );
    await client.unsafe("ANALYZE items");
    await client.unsafe("ANALYZE edges");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function planOf(
    build: (db: ReturnType<typeof drizzlePg>) => Promise<unknown>,
    probeName: string,
  ): Promise<string> {
    const client = ctx.storage.pgClient as Sql;
    const captured: CapturedQuery[] = [];
    const db = drizzlePg(client, { logger: capturingLogger(captured) });
    await build(db);
    const query = captured.at(-1);
    expect(query).toBeDefined();

    // Force the generic plan, the steady state a prepared statement
    // reaches in production. A custom plan sees the bound values and can
    // reason from them, so explaining with params would pass for a query
    // that does not deserve it.
    return await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL plan_cache_mode = force_generic_plan");
      await tx.unsafe(`PREPARE ${probeName} AS ${query!.sql}`);
      const args = query!.params
        .map((p) => (typeof p === "number" ? String(p) : `'${String(p)}'`))
        .join(", ");
      const rows = await tx.unsafe(
        `EXPLAIN (FORMAT TEXT) EXECUTE ${probeName}(${args})`,
      );
      return rows
        .map((r) => String((r as Record<string, unknown>)["QUERY PLAN"]))
        .join("\n");
    });
  }

  it("walks the index for a space-bound read, with no sort", async () => {
    const text = await planOf(
      (db) =>
        new PgItemStore(db as never, null as never, null as never).list({
          spaceId: SPACE,
          updated_after: CURSOR,
          limit: 50,
        }),
      "catch_up_plan_scoped",
    );
    expect(text).toContain("idx_items_updated_at_id");
    expect(text).not.toContain("Sort Key");
  });

  it("walks the index for a space-less read, with no sort", async () => {
    const text = await planOf(
      (db) =>
        new PgItemStore(db as never, null as never, null as never).list({
          updated_after: CURSOR,
          limit: 50,
        }),
      "catch_up_plan_unscoped",
    );
    expect(text).toContain("idx_items_updated_at_id");
    expect(text).not.toContain("Sort Key");
  });

  it("walks the index for the edge half", async () => {
    const text = await planOf(
      (db) =>
        new PgEdgeStore(db as never).list({
          spaceId: SPACE,
          updated_after: CURSOR,
          limit: 50,
        }),
      "catch_up_plan_edges",
    );
    expect(text).toContain("idx_edges_updated_at_id");
    expect(text).not.toContain("Sort Key");
  });
});
