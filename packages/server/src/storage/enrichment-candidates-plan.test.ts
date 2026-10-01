/**
 * Read from the query plan, not reasoning — it silently regressed to a full
 * scan once. Literals stay inlined; a bound param defeats the proof.
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

async function candidatePlan(): Promise<{ plan: string; params: unknown[] }> {
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(SCHEMA_SQL);
    const captured: CapturedQuery[] = [];
    const db = drizzleSqlite(client, { logger: capturingLogger(captured) });
    const store = new SqliteEnrichmentStore(db as never);
    await store.listCandidates(3, 8, SIGNATURE);

    const query = captured.at(-1);
    expect(query).toBeDefined();
    // Explained unsubstituted: SQLite plans at prepare time, before binding,
    // so pre-substituting params would hide the mistake this guards against.
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

// The desired shape: an ordered walk of the partial index, already sorted
// by created_at, the queue's serving order — not a scan plus a temp sort.
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
});
