/**
 * The cycle check walks only the edges reachable from the new edge's target.
 *
 * The plan is read from the statement the store really sends, on a store
 * with enough edges that a scan or an automatic index shows. The witness for
 * the plan assertions is `SCAN edges` in the plan of the old shape, kept
 * below as `WHOLE_TABLE_CHECK`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const NOW = "2026-01-01T00:00:00.000Z";
const PARENT_OF_EDGES = 100_000;

const WHOLE_TABLE_CHECK = `WITH RECURSIVE
  pending(source_id, target_id) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)),
  relation(source_id, target_id) AS (
    SELECT source_id, target_id FROM edges WHERE edge_type IN (SELECT value FROM json_each(?))
    UNION ALL SELECT source_id, target_id FROM pending),
  reachable(id) AS (SELECT ? UNION SELECT relation.target_id FROM relation JOIN reachable ON relation.source_id = reachable.id)
  SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1`;

let directory: string;
let path: string;
let storage: Storage;
let reader: Client;
let sent: { sql: string; args: InArgs }[] | null = null;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-edge-cycle-"));
  path = join(directory, "test.db");
  storage = await createSqliteStorage(path);
  reader = createClient({ url: `file:${path}` });
  const driver = Object.getPrototypeOf(createClient({ url: ":memory:" })) as {
    execute: (
      this: Client,
      statement: InStatement | string,
      args?: InArgs,
    ) => Promise<ResultSet>;
  };
  const execute = driver.execute;
  vi.spyOn(driver, "execute").mockImplementation(function (
    this: Client,
    statement,
    args,
  ) {
    if (sent) {
      sent.push(
        typeof statement === "string"
          ? { sql: statement, args: args ?? [] }
          : { sql: statement.sql, args: statement.args ?? [] },
      );
    }
    return execute.call(this, statement, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  sent = null;
  reader.close();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

async function link(
  type: string,
  pairs: [source: string, target: string][],
): Promise<void> {
  for (const [source, target] of pairs) {
    await storage.__sqliteRun(
      `INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, '{}', ?, ?, 1)`,
      [`${type}:${source}>${target}`, source, target, type, NOW, NOW],
    );
  }
}

function wouldCycle(
  types: string[],
  source: string,
  target: string,
  pending: [string, string][] = [],
): Promise<boolean> {
  return storage.edges.wouldCreateCycle(
    types,
    source,
    target,
    pending.map(([source_id, target_id]) => ({ source_id, target_id })),
  );
}

describe("which edges close a cycle", () => {
  it("refuses an edge whose reverse is stored", async () => {
    await link("parent-of", [["a", "b"]]);
    expect(await wouldCycle(["parent-of"], "b", "a")).toBe(true);
  });

  it("refuses an edge that closes a long chain at its far end", async () => {
    const chain: [string, string][] = [];
    for (let i = 0; i < 200; i++)
      chain.push([`n${String(i)}`, `n${String(i + 1)}`]);
    await link("parent-of", chain);
    expect(await wouldCycle(["parent-of"], "n200", "n0")).toBe(true);
    expect(await wouldCycle(["parent-of"], "n0", "n200")).toBe(false);
  });

  it("refuses an edge that closes a cycle through an earlier pending edge", async () => {
    await link("parent-of", [["a", "b"]]);
    expect(await wouldCycle(["parent-of"], "c", "a", [["b", "c"]])).toBe(true);
    expect(await wouldCycle(["parent-of"], "c", "a", [["b", "d"]])).toBe(false);
  });

  it("refuses a cycle that runs through pending edges alone", async () => {
    expect(
      await wouldCycle(["parent-of"], "c", "a", [
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toBe(true);
  });

  it("follows every listed edge type and no other", async () => {
    await link("parent-of", [["a", "b"]]);
    await link("part-of", [["b", "c"]]);
    await link("about", [["c", "d"]]);
    expect(await wouldCycle(["parent-of", "part-of"], "c", "a")).toBe(true);
    expect(await wouldCycle(["parent-of"], "c", "a")).toBe(false);
    expect(await wouldCycle(["parent-of", "part-of"], "d", "a")).toBe(false);
  });

  it("refuses a self-edge reached as its own target", async () => {
    expect(await wouldCycle(["parent-of"], "a", "a")).toBe(true);
  });

  it("allows an edge to a target with no children", async () => {
    await link("parent-of", [["a", "b"]]);
    expect(await wouldCycle(["parent-of"], "b", "leaf")).toBe(false);
  });

  it("allows a diamond", async () => {
    await link("parent-of", [
      ["top", "left"],
      ["top", "right"],
      ["left", "bottom"],
    ]);
    expect(await wouldCycle(["parent-of"], "right", "bottom")).toBe(false);
  });

  it("ends on a cycle already stored", async () => {
    await link("parent-of", [
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(await wouldCycle(["parent-of"], "z", "x")).toBe(false);
  });
});

describe("the check at scale", () => {
  async function fill(): Promise<void> {
    // A tree: node i has the parent p(i / 4), so a leaf has no outgoing edge.
    await storage.__sqliteRun(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at, version)
       SELECT 'e' || i, 'p' || (i / 4), 'p' || i, 'parent-of', '{}', ?, ?, 1 FROM n`,
      [PARENT_OF_EDGES, NOW, NOW],
    );
  }

  async function planOf(
    call: () => Promise<unknown>,
    only: (sql: string) => boolean,
  ): Promise<string> {
    sent = [];
    await call();
    const statements = sent.filter(({ sql }) => only(sql));
    sent = null;
    expect(statements.length).toBe(1);
    const rows = await reader.execute({
      sql: `EXPLAIN QUERY PLAN ${statements[0]!.sql}`,
      args: statements[0]!.args,
    });
    return rows.rows.map((row) => row.detail as string).join(" | ");
  }

  it("shows a scan and an automatic index in the old shape, as the witness", async () => {
    await fill();
    const rows = await reader.execute({
      sql: `EXPLAIN QUERY PLAN ${WHOLE_TABLE_CHECK}`,
      args: ["[]", '["parent-of"]', "p99999", "p1"],
    });
    const plan = rows.rows.map((row) => row.detail as string).join(" | ");
    expect(plan).toContain("SCAN edges");
    expect(plan).toContain("AUTOMATIC");
  });

  it("walks edges through the source index, with no scan and no automatic index", async () => {
    await fill();
    const plan = await planOf(
      () => wouldCycle(["parent-of"], "p1", "p99999"),
      (sql) => /with recursive/i.test(sql),
    );
    expect(plan).toContain("SEARCH edges USING INDEX idx_edges_source");
    expect(plan).not.toMatch(/SCAN edges/);
    expect(plan).not.toMatch(/AUTOMATIC/);
  });

  it("keeps the stored edges on the index when the request has pending edges", async () => {
    await fill();
    const plan = await planOf(
      () => wouldCycle(["parent-of"], "p1", "p99999", [["p5", "p6"]]),
      (sql) => /with recursive/i.test(sql),
    );
    expect(plan).toContain("SEARCH edges USING INDEX idx_edges_source");
    expect(plan).not.toMatch(/SCAN edges/);
    expect(plan).not.toMatch(/AUTOMATIC \w+ INDEX[^|]*edges/);
  });

  it("walks a 100,000-edge tree from its leaf and from its top", async () => {
    await fill();
    expect(await wouldCycle(["parent-of"], "p1", "p99999")).toBe(false);
    expect(await wouldCycle(["parent-of"], "p99999", "p1")).toBe(true);
  }, 60_000);
});
