/**
 * The enrichment candidate query must be index-served, verified by reading
 * the query plan rather than by reasoning about it. It runs on a timer
 * forever, so on an extracted corpus it has to cost nothing — and it once
 * shipped as a full scan plus a sort behind a comment claiming otherwise.
 *
 * The check captures the SQL the real store issues (via a Drizzle logger
 * wrapped around the same connection) and asks the database how it would
 * run it. That the store inlines its state and blob literals is
 * load-bearing: a bound parameter defeats the partial-index implication
 * proof. The type list is bound, and grows with the registry, so the plan
 * is read with and without a type that inherits its way to a file. A third
 * case re-applies the schema onto a database that already carries the index
 * under its pre-rename name, to prove `IF NOT EXISTS` does not quietly keep
 * serving that stale predicate once a type inherits its way to a file.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { SqliteEnrichmentStore } from "./sqlite/enrichment-store.js";
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

const SIGNATURE = JSON.stringify({ max_blob_bytes: 1, ocr: false });

async function candidatePlan(opts?: {
  seedLegacyIndex?: boolean;
}): Promise<{ plan: string; params: unknown[] }> {
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(SCHEMA_SQL);
    if (opts?.seedLegacyIndex) {
      // What a pre-rename build already wrote: the same name, but the old
      // type-filtered predicate. Dropped and recreated rather than just
      // created, so this also covers the pre-rename name, which the schema
      // just applied above under its current (type-free) predicate.
      await client.execute(
        "DROP INDEX IF EXISTS `idx_items_enrichment_candidates`",
      );
      await client.execute(
        "CREATE INDEX `idx_items_enrichment_candidates` ON `items` (`created_at`) WHERE (type = 'core.file' OR type LIKE 'core.file.%') AND state <> 'trashed' AND json_extract(properties, '$.blob_ref') IS NOT NULL;",
      );
      // Every boot re-applies the current schema, idempotently — this is
      // the load-bearing step: `IF NOT EXISTS` must not repair the stale
      // index above just because it shares the pre-rename name.
      await client.executeMultiple(SCHEMA_SQL);
    }
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
    return {
      plan: plan.rows
        .map((r) => String((r as Record<string, unknown>).detail))
        .join("\n"),
      params: query!.params,
    };
  } finally {
    client.close();
  }
}

// "SCAN items USING INDEX idx_…" is the desired shape: an ordered walk of the
// partial index, already sorted by the column the index is keyed on —
// created_at, which is when a file arrived and the order the queue is served
// in. The bad plan is a bare table scan plus a temporary sort.
function expectIndexServed(plan: string): void {
  expect(plan).toContain("SCAN items USING INDEX idx_items_enrichment_queue");
  expect(plan).not.toContain("TEMP B-TREE");
}

describe("sqlite candidate query plan", () => {
  it("is served by the partial index, per EXPLAIN QUERY PLAN", async () => {
    const { plan, params } = await candidatePlan();
    expect(params).not.toContain("acme.photo");
    expectIndexServed(plan);
  });

  it("is served by the partial index when a type inherits its way to a file", async () => {
    registerTypeSchema({
      id: "acme.photo",
      version: 1,
      parent: "core.file.image",
      fields: {},
    });
    try {
      const { plan, params } = await candidatePlan();
      expect(params).toContain("acme.photo");
      expectIndexServed(plan);
    } finally {
      unregisterTypeSchema("acme.photo");
    }
  });

  it("is served by the renamed index on a database an earlier build wrote", async () => {
    registerTypeSchema({
      id: "acme.photo",
      version: 1,
      parent: "core.file.image",
      fields: {},
    });
    try {
      const { plan } = await candidatePlan({ seedLegacyIndex: true });
      expectIndexServed(plan);
    } finally {
      unregisterTypeSchema("acme.photo");
    }
  });
});
