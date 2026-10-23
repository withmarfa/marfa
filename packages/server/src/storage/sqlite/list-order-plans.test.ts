/**
 * A page of a listing reads about the rows it answers, whatever filters
 * narrow it, because no step of its plan sorts the whole match.
 *
 * A listing of a type and what is under it used to read every matching row
 * and sort them (`USE TEMP B-TREE FOR ORDER BY`), so a page cost the same as
 * the whole list. It now reads each slice of the type predicate in order from
 * an index on `(type, <sort column>, id)` and merges the slices. A slice that
 * holds a type nothing registers is a range an index cannot order, and it
 * sorts only its own rows.
 *
 * The plans are read from the statements the store really sends.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import {
  registerTypeSchema,
  unregisterTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import type { ItemFilters } from "../interface.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;
interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

const REGISTERED: [string, string | undefined][] = [
  ["user.docs", undefined],
  ["user.docs.a", "user.docs"],
  ["user.docs.b", "user.docs"],
  ["user.decl", "user.docs"],
  ["user.other", undefined],
];
const PER_TYPE = 500;
const SORT_INDEX = {
  created_at: "idx_items_type_created_at",
  updated_at: "idx_items_type_updated_at",
  occurred_at: "idx_items_type_occurred_at",
} as const;

let directory: string;
let path: string;
let storage: Storage;
let reader: Client;
let sent: { sql: string; args: InArgs }[] | null = null;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-list-order-plans-"));
  path = join(directory, "test.db");
  storage = await createSqliteStorage(path);
  for (const [id, parent] of REGISTERED) {
    registerTypeSchema({
      id,
      name: id,
      description: "test",
      parent,
      version: 1,
      fields: {},
    } as unknown as TypeSchema);
  }
  for (const [type] of REGISTERED) {
    await storage.__sqliteRun(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, source, version)
       SELECT ? || '#' || i, ?, 'active', CASE WHEN i % 4 = 0 THEN 'feed' ELSE 'library' END, jsonb('{}'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 1767225600 + ((i * 5) % 211) / 2, 'unixepoch'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 1767225600 + ((i * 7) % 223) / 2, 'unixepoch'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 1767225600 + ((i * 3) % 199) / 2, 'unixepoch'),
              CASE WHEN i % 2 = 0 THEN 'one' ELSE 'two' END, 1 FROM n`,
      [PER_TYPE, type, type],
    );
  }
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

afterEach(() => {
  sent = null;
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const [id] of REGISTERED) unregisterTypeSchema(id);
  reader.close();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

/** The plan of the one statement a listing sends that reads `items`. */
async function planOf(filters: ItemFilters): Promise<PlanRow[]> {
  sent = [];
  await storage.items.list(filters);
  const statements = sent.filter(({ sql }) =>
    /from\s+["`]?items["`]?[\s,]/i.test(sql),
  );
  sent = null;
  expect(statements).toHaveLength(1);
  const { sql, args } = statements[0]!;
  const rows = await reader.execute({
    sql: `EXPLAIN QUERY PLAN ${sql}`,
    args,
  });
  return rows.rows.map((row) => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: row.detail as string,
  }));
}

/**
 * The sorts in a plan that order more than a slice nothing registers: every
 * `ORDER BY` sort that does not sit beside a search of a range of types.
 */
function wholeSorts(plan: PlanRow[]): string[] {
  return plan
    .filter((row) => row.detail === "USE TEMP B-TREE FOR ORDER BY")
    .filter(
      (sort) =>
        !plan.some(
          (other) =>
            other.parent === sort.parent &&
            /^SEARCH items .*\(type>/.test(other.detail),
        ),
    )
    .map((row) => `${String(row.id)}/${String(row.parent)}`);
}

const text = (plan: PlanRow[]) => plan.map((row) => row.detail).join(" | ");

const LISTINGS: Record<string, ItemFilters> = {
  "a type with subtypes": { type: "user.docs" },
  "a subtree wildcard": { type: "user.docs.*" },
  "a leaf type": { type: "user.docs.a" },
  "a type and a tier": { type: "user.docs", tier: "feed" },
  "a type and a source": { type: "user.docs", source: "one" },
  "a type and time bounds": {
    type: "user.docs",
    occurred_after: "2026-01-01T00:00:10.000Z",
    occurred_before: "2026-01-01T00:00:50.000Z",
  },
  "grants with an exclusion": {
    allowed_types: ["user.docs.*", "user.other"],
    excluded_types: ["user.docs.b"],
  },
  "grants of names": { allowed_types: ["user.docs.a", "user.other"] },
  "a type under grants": {
    type: "user.docs",
    allowed_types: ["user.docs.*", "user.decl"],
  },
  "a type and a source filter": {
    type: "user.docs",
    source_filter: { types: ["user.docs.b"], sources: ["one"] },
  },
};

describe("a typed listing in a system order", () => {
  for (const [name, filters] of Object.entries(LISTINGS)) {
    for (const sort of ["created_at", "updated_at", "occurred_at"] as const) {
      for (const direction of ["desc", "asc"] as const) {
        it(`sorts no whole match for ${name}, ${sort} ${direction}`, async () => {
          const plan = await planOf({ ...filters, sort, direction });
          expect(wholeSorts(plan)).toEqual([]);
          expect(text(plan)).toContain(SORT_INDEX[sort]);
        });
      }
    }
  }

  it("sorts no whole match for a catch-up", async () => {
    for (const filters of [
      { updated_after: "2026-01-01T00:00:10.000Z", type: "user.docs" },
      {
        updated_after: "2026-01-01T00:00:10.000Z",
        allowed_types: ["user.docs.*", "user.other"],
      },
    ] satisfies ItemFilters[]) {
      const plan = await planOf(filters);
      expect(wholeSorts(plan)).toEqual([]);
      expect(text(plan)).toContain("idx_items_type_updated_at");
    }
  });

  it("continues from a cursor without a sort of the whole match", async () => {
    const first = await storage.items.list({ type: "user.docs", limit: 20 });
    const plan = await planOf({
      type: "user.docs",
      limit: 20,
      cursor: first.next_cursor!,
    });
    expect(wholeSorts(plan)).toEqual([]);
    expect(text(plan)).toMatch(
      /idx_items_type_created_at \(type=\? AND \(created_at,id\)<\(\?,\?\)\)/,
    );
  });

  it("reads a type that nothing registers from a range of its own", async () => {
    const plan = await planOf({ type: "user.docs" });
    expect(plan.some((row) => /SEARCH items .*\(type>/.test(row.detail))).toBe(
      true,
    );
  });

  it("reads one slice per registered type and per gap, and not the others", async () => {
    const plan = await planOf({ type: "user.docs" });
    const searches = plan.filter((row) =>
      row.detail.startsWith("SEARCH items"),
    );
    // user.docs, a, b, decl, and the gaps before a, between a and b, and
    // between b and the end of the namespace.
    expect(searches).toHaveLength(7);
    const other = await planOf({ type: "user.other" });
    expect(other.filter((row) => row.detail.startsWith("SEARCH"))).toHaveLength(
      2,
    );
  });

  it("falls back to one read and a sort past the most slices a statement carries", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 130; i++) {
      const id = `user.wide.t${String(i).padStart(3, "0")}`;
      ids.push(id);
      registerTypeSchema({
        id,
        name: id,
        description: "test",
        version: 1,
        fields: {},
      } as unknown as TypeSchema);
    }
    try {
      const plan = await planOf({ type: "user.wide" });
      expect(text(plan)).not.toContain("MERGE");
      expect(text(plan)).toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      for (const id of ids) unregisterTypeSchema(id);
    }
  });

  it("goes back to sorting the whole match without the sort column's index", async () => {
    // The witness: the same listings, on the same rows, with the indexes the
    // plans above name removed, read and sort every row of the type.
    await storage.__sqliteRun("DROP INDEX idx_items_type_created_at", []);
    reader.close();
    reader = createClient({ url: `file:${path}` });
    try {
      const plan = await planOf({ type: "user.docs" });
      expect(wholeSorts(plan).length).toBeGreaterThan(0);
      expect(text(plan)).not.toContain("idx_items_type_created_at");
    } finally {
      await storage.__sqliteRun(
        "CREATE INDEX idx_items_type_created_at ON items (type, created_at, id)",
        [],
      );
      reader.close();
      reader = createClient({ url: `file:${path}` });
    }
  });
});

describe("an untyped listing in a system order", () => {
  it.each(["created_at", "updated_at", "occurred_at"] as const)(
    "walks the %s index and sorts no whole match",
    async (sort) => {
      for (const direction of ["desc", "asc"] as const) {
        const plan = await planOf({ sort, direction });
        expect(text(plan)).toMatch(new RegExp(`idx_items_${sort}`));
        expect(text(plan)).not.toContain("idx_items_state");
        expect(text(plan)).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
    },
  );
});
