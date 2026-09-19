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
 * The index leads on `updated_at`: an index that narrows on some other
 * column first would leave the planner nothing to walk for the ordering,
 * and the read came back `SCAN items` plus `USE TEMP B-TREE FOR ORDER BY`,
 * which is the plan the index exists to prevent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { SqliteItemStore } from "./sqlite/item-store.js";
import { SqliteEdgeStore } from "./sqlite/edge-store.js";
import { SCHEMA_SQL } from "./sqlite/connection.js";

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
    // the index being tested.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) {
      // Mixed: a corpus in which nothing is trashed is not one a catch-up
      // read ever meets.
      const state = i % 5 === 0 ? "trashed" : "active";
      const stamp = `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
      rows.push(
        `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version) VALUES ('i${String(i)}', 'core.note', '${state}', 'library', '{}', '${stamp}', '${stamp}', '${stamp}', 1);`,
        `INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at) VALUES ('e${String(i)}', 'i${String(i)}', 'i${String((i + 1) % 400)}', 'references', '{}', '${stamp}', '${stamp}');`,
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

  it("walks the index for the item half, with no sort", async () => {
    const store = new SqliteItemStore(
      db as never,
      null as never,
      null as never,
    );
    const detail = await planOf(() =>
      store.list({ updated_after: CURSOR, limit: 50 }),
    );
    expect(detail).toContain("idx_items_updated_at_id");
    // The half an index on the predicate alone would not buy. A temporary
    // b-tree here means every catch-up sorts the corpus it matched.
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("walks the index for the edge half", async () => {
    const store = new SqliteEdgeStore(db as never);
    const detail = await planOf(() =>
      store.list({ updated_after: CURSOR, limit: 50 }),
    );
    expect(detail).toContain("idx_edges_updated_at_id");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});
