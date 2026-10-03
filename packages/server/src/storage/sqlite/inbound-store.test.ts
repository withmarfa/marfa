import type { MockInstance } from "vitest";
import type { InStatement, ResultSet } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "./connection.js";
import { SqliteInboundStore } from "./inbound-store.js";
import { connectors, inboundEndpoints, inboundDeliveries } from "./schema.js";

type DeliveryRow = typeof inboundDeliveries.$inferInsert;
const stamp = "2026-01-01T00:00:00.000Z";
const headers: [string, string][] = [
  ["X-Key", "a"],
  ["x-key", "b"],
];
let connection: Awaited<ReturnType<typeof createConnection>>;
let directory: string;
let store: SqliteInboundStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-inbound-store-"));
  connection = await createConnection(join(directory, "test.db"));
  store = new SqliteInboundStore(connection.db);
  await connection.db.insert(connectors).values({
    id: "connector",
    key_id: "key",
    source: "test",
    name: "test",
    registered_at: stamp,
    updated_at: stamp,
  });
  await connection.db.insert(inboundEndpoints).values(
    ["endpoint", "endpoint:a"].map((id) => ({
      id,
      connector_id: "connector",
      token_hash: id,
      token_last4: "test",
      created_at: stamp,
      duplicate_header: "x-key",
    })),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await connection.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function seed(
  rows: {
    id: string;
    dedupe_key: string | null;
    endpoint_id?: string;
    handled_at?: string | null;
    outcome?: string | null;
  }[],
) {
  await connection.db.insert(inboundDeliveries).values(
    rows.map((row): DeliveryRow => ({
      endpoint_id: "endpoint",
      connector_id: "connector",
      received_at: stamp,
      method: "POST",
      query: "?a=1",
      headers: JSON.stringify(headers),
      size: 0,
      stored_bytes: 100,
      sha256: "hash",
      ...row,
    })),
  );
}

function list(
  limit = 200,
  cursor?: string,
  state: "pending" | "handled" | "any" = "pending",
  endpointId?: string,
) {
  return store.listDeliveries(
    "connector",
    { state, endpointId },
    { limit, cursor },
  );
}

function executeSpy() {
  return vi.spyOn(connection.raw, "execute") as MockInstance<
    (statement: InStatement | string) => Promise<ResultSet>
  >;
}

function resolutionCalls(spy: ReturnType<typeof executeSpy>) {
  return spy.mock.calls.filter(([statement]) =>
    (typeof statement === "string" ? statement : statement.sql).includes(
      "WITH requested",
    ),
  );
}

describe("inbound duplicate resolution on native SQLite", () => {
  it("uses two reads for 200 repeated pairs and preserves tied ordering and the cursor", async () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) => `row-${String(i).padStart(3, "0")}`,
    );
    await seed([...ids].reverse().map((id) => ({ id, dedupe_key: "same" })));
    const spy = executeSpy();
    const first = await list();
    expect(first.data.map((row) => row.id)).toEqual(ids.slice(0, 200));
    expect(first.data[0]?.duplicate_of).toBeNull();
    expect(
      first.data.slice(1).every((row) => row.duplicate_of?.id === ids[0]),
    ).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(resolutionCalls(spy)).toHaveLength(1);
    const statement = resolutionCalls(spy)[0]?.[0];
    if (statement === undefined || typeof statement === "string")
      throw new Error("Expected bound statement");
    expect(statement.args).toHaveLength(2);
    spy.mockClear();
    const last = await list(200, first.next_cursor!);
    expect(last.data.map((row) => row.id)).toEqual([ids[200]]);
    expect(last.data[0]?.duplicate_of).toEqual({ id: ids[0], outcome: null });
    expect(last.next_cursor).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("batches 200 distinct exact pairs without endpoint or delimiter collisions", async () => {
    await seed(
      [
        { id: "old-a", endpoint_id: "endpoint:a", dedupe_key: "b" },
        { id: "old-b", endpoint_id: "endpoint", dedupe_key: "a:b" },
        { id: "old-c", endpoint_id: "endpoint", dedupe_key: "b" },
      ].map((row) => ({ ...row, handled_at: stamp, outcome: "processed" })),
    );
    const pairs = [
      { id: "row-000", endpoint_id: "endpoint:a", dedupe_key: "b" },
      { id: "row-001", endpoint_id: "endpoint", dedupe_key: "a:b" },
      { id: "row-002", endpoint_id: "endpoint", dedupe_key: "b" },
      ...Array.from({ length: 197 }, (_, i) => ({
        id: `row-${String(i + 3).padStart(3, "0")}`,
        dedupe_key: `key:${String(i)}`,
      })),
    ];
    await seed(pairs);
    const spy = executeSpy();
    const page = await list();
    expect(page.data.slice(0, 3).map((row) => row.duplicate_of?.id)).toEqual([
      "old-a",
      "old-b",
      "old-c",
    ]);
    expect(page.data.slice(3).every((row) => row.duplicate_of === null)).toBe(
      true,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(resolutionCalls(spy)).toHaveLength(1);
    const statement = resolutionCalls(spy)[0]?.[0];
    if (statement === undefined || typeof statement === "string")
      throw new Error("Expected bound statement");
    expect(statement.args).toHaveLength(400);
    spy.mockRestore();
    const plan = await connection.raw.execute({
      ...statement,
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    });
    expect(
      plan.rows.some((row) =>
        (typeof row.detail === "string" ? row.detail : "").includes(
          "idx_inbound_deliveries_endpoint_dedupe",
        ),
      ),
    ).toBe(true);
    expect(
      plan.rows.some((row) =>
        (typeof row.detail === "string" ? row.detail : "").includes(
          "SCAN candidate",
        ),
      ),
    ).toBe(false);
  });

  it("keeps null and empty keys distinct and skips enrichment for unkeyed and empty pages", async () => {
    await seed([
      { id: "a", dedupe_key: null },
      { id: "b", dedupe_key: "" },
      { id: "c", dedupe_key: "" },
      { id: "d", dedupe_key: null },
      { id: "e", dedupe_key: "normal" },
    ]);
    const spy = executeSpy();
    const mixed = await list();
    expect(mixed.data.map((row) => row.duplicate_of)).toEqual([
      null,
      null,
      { id: "b", outcome: null },
      null,
      null,
    ]);
    expect(mixed.data.map((row) => row.headers)).toEqual(
      Array.from({ length: 5 }, () => headers),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    const unkeyed = await list(1);
    expect(unkeyed.data[0]?.id).toBe("a");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    expect((await list(200, undefined, "handled")).data).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("finds the handled off-page original and promotes the next retained row after cleanup", async () => {
    await seed([
      { id: "c", dedupe_key: "same" },
      { id: "b", dedupe_key: "same" },
      { id: "a", dedupe_key: "same", handled_at: stamp, outcome: "processed" },
    ]);
    const first = await list(1);
    expect(first.data[0]?.id).toBe("b");
    expect(first.data[0]?.duplicate_of).toEqual({
      id: "a",
      outcome: "processed",
    });
    const second = await list(1, first.next_cursor!, "pending", "endpoint");
    expect(second.data[0]?.duplicate_of).toEqual({
      id: "a",
      outcome: "processed",
    });
    expect(await store.cleanup({ handledDays: 1, pendingDays: 0 })).toEqual({
      deleted: 1,
      remaining: false,
    });
    const retained = await list();
    expect(retained.data.map((row) => row.id)).toEqual(["b", "c"]);
    expect(retained.data.map((row) => row.duplicate_of)).toEqual([
      null,
      { id: "b", outcome: null },
    ]);
  });

  it("batches handling metadata while keeping request order and the first handling mark", async () => {
    await seed(["c", "b", "a"].map((id) => ({ id, dedupe_key: "same" })));
    const spy = executeSpy();
    const marked = await store.markHandled(
      "connector",
      ["c", "a", "c", "b"],
      "processed",
    );
    expect(marked?.map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(marked?.map((row) => row.duplicate_of)).toEqual([
      { id: "a", outcome: "processed" },
      null,
      { id: "a", outcome: "processed" },
    ]);
    expect(resolutionCalls(spy)).toHaveLength(1);
    spy.mockClear();
    const repeated = await store.markHandled(
      "connector",
      ["b", "a"],
      "rejected",
    );
    expect(repeated?.map((row) => row.id)).toEqual(["b", "a"]);
    expect(repeated?.map((row) => row.outcome)).toEqual([
      "processed",
      "processed",
    ]);
    expect(repeated?.map((row) => row.handled_at)).toEqual([
      marked?.[2]?.handled_at,
      marked?.[1]?.handled_at,
    ]);
    expect(repeated?.[0]?.duplicate_of).toEqual({
      id: "a",
      outcome: "processed",
    });
    expect(resolutionCalls(spy)).toHaveLength(1);
  });
});
