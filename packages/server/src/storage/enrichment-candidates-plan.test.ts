/**
 * The enrichment candidate query must be index-served, verified by reading
 * the query plan rather than by reasoning about it. It runs on a timer
 * forever, so on an extracted corpus it has to cost nothing — and it once
 * shipped as a full scan plus a sort behind a comment claiming otherwise.
 *
 * The check captures the SQL the real store issues (via a Drizzle logger
 * wrapped around the same connection) and ask the database how it would
 * run it. That the store inlines its type/state literals is load-bearing:
 * a bound parameter defeats the partial-index implication proof.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { SqliteEnrichmentStore } from "./sqlite/enrichment-store.js";
import { SCHEMA_SQL } from "./sqlite/schema-sql.generated.js";

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

const SIGNATURE = JSON.stringify({ max_blob_bytes: 1, ocr: false });

describe("sqlite candidate query plan", () => {
  it("is served by the partial index, per EXPLAIN QUERY PLAN", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.executeMultiple(SCHEMA_SQL);
      const captured: CapturedQuery[] = [];
      const db = drizzleSqlite(client, { logger: capturingLogger(captured) });
      const store = new SqliteEnrichmentStore(db as never);
      await store.listCandidates(1, 3, 8, SIGNATURE);

      const query = captured.at(-1);
      expect(query).toBeDefined();
      // Explain the parameterized statement as-is. SQLite plans at prepare
      // time, before any value is bound, so substituting the params first
      // would show a plan production never gets — the exact mistake the
      // literal inlining in the store exists to avoid.
      const plan = await client.execute(
        `EXPLAIN QUERY PLAN ${query!.sql}`,
        query!.params as never[],
      );
      const detail = plan.rows
        .map((r) => String((r as Record<string, unknown>).detail))
        .join("\n");
      // "SCAN items USING INDEX idx_…" is the desired shape: an ordered
      // walk of the partial index, already sorted by the column the index is
      // keyed on — created_at, which is when a file arrived and the order
      // the queue is served in. The bad plan is a bare table scan plus a
      // temporary sort.
      expect(detail).toContain(
        "SCAN items USING INDEX idx_items_enrichment_candidates",
      );
      expect(detail).not.toContain("TEMP B-TREE");
    } finally {
      client.close();
    }
  });
});
