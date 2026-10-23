/**
 * A listing answers the same rows in the same order whatever type predicate
 * and filters narrow it, and a cursor taken at any row continues from it.
 *
 * The expected answer is computed in JavaScript from every stored row, with
 * the JavaScript twins of the SQL predicates (`typeAnswersSubtreeFilter`,
 * `matchesTypeFilter`, `sourceFilterIncludesItem`), so it shares no SQL with
 * the store. The rows tie on every time column on purpose: the order inside
 * a tie is the identifier, and a cursor falls inside ties.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesTypeFilter,
  registerTypeSchema,
  typeAnswersSubtreeFilter,
  unregisterTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import {
  cursorSortKey,
  encodeKeyedCursor,
  type ItemFilters,
} from "../interface.js";
import { sourceFilterIncludesItem } from "../filter-sql.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

interface Row {
  id: string;
  type: string;
  state: string;
  tier: string;
  created_at: string;
  updated_at: string;
  occurred_at: string;
  source: string | null;
}

const REGISTERED: [string, string | undefined][] = [
  ["user.docs", undefined],
  ["user.docs.a", "user.docs"],
  ["user.docs.b", "user.docs"],
  ["user.docs.b.deep", "user.docs.b"],
  // Declares its way under `user.docs` from outside its namespace.
  ["user.decl", "user.docs"],
  ["user.other", undefined],
];
// Stored with no schema: a listing must still read them.
const UNREGISTERED = [
  "user.docs.ghost",
  "user.docs.zz.deep",
  "user.docsx",
  "user.doc",
  "user.docs-other",
  "system.thing",
];
const TYPES = [...REGISTERED.map(([id]) => id), ...UNREGISTERED];
const SOURCES = ["one", "two", null] as const;

const PER_TYPE = 36;
const PAGE = 7;

/** A fixed-width instant; few distinct values, so every column ties. */
function instant(slot: number): string {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, slot * 7, slot % 5));
  return at.toISOString();
}

function rowsOf(): Row[] {
  const rows: Row[] = [];
  for (const [t, type] of TYPES.entries()) {
    for (let i = 0; i < PER_TYPE; i++) {
      const n = t * PER_TYPE + i;
      rows.push({
        id: `${type}#${String(i).padStart(3, "0")}`,
        type,
        state: i % 9 === 0 ? "archived" : "active",
        tier: i % 4 === 0 ? "feed" : "library",
        created_at: instant((n * 5) % 11),
        updated_at: instant((n * 7) % 13),
        occurred_at: instant((n * 3) % 6),
        source: SOURCES[n % SOURCES.length]!,
      });
    }
  }
  return rows;
}

const ALL = rowsOf();

let directory: string;
let storage: Storage;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-list-order-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
  // After the store opens, which sets the registry up afresh.
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
  for (const row of ALL) {
    await storage.__sqliteRun(
      `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, source, version)
       VALUES (?, ?, ?, ?, jsonb('{}'), ?, ?, ?, ?, 1)`,
      [
        row.id,
        row.type,
        row.state,
        row.tier,
        row.created_at,
        row.updated_at,
        row.occurred_at,
        row.source,
      ],
    );
  }
});

afterAll(async () => {
  for (const [id] of REGISTERED) unregisterTypeSchema(id);
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The ids a listing with these filters answers, in order. */
function expected(filters: ItemFilters): Row[] {
  const catchUp = filters.updated_after !== undefined;
  const column =
    catchUp || filters.sort === "updated_at"
      ? "updated_at"
      : filters.sort === "occurred_at"
        ? "occurred_at"
        : "created_at";
  const direction = catchUp ? "asc" : (filters.direction ?? "desc");
  const kept = ALL.filter((row) => {
    if (filters.state ? row.state !== filters.state : row.state !== "active")
      return false;
    // An empty `type` is no filter, as the count reads it.
    if (filters.type && !typeAnswersSubtreeFilter(row.type, filters.type))
      return false;
    if (
      filters.allowed_types !== undefined &&
      !matchesTypeFilter(row.type, {
        allowed: filters.allowed_types,
        excluded: filters.excluded_types ?? [],
      })
    )
      return false;
    if (filters.source !== undefined && row.source !== filters.source)
      return false;
    if (filters.tier !== undefined && row.tier !== filters.tier) return false;
    if (filters.exclude_system_types && row.type.startsWith("system."))
      return false;
    if (
      filters.occurred_after !== undefined &&
      !(row.occurred_at > filters.occurred_after)
    )
      return false;
    if (
      filters.occurred_before !== undefined &&
      !(row.occurred_at < filters.occurred_before)
    )
      return false;
    if (
      filters.updated_after !== undefined &&
      !(row.updated_at >= filters.updated_after)
    )
      return false;
    if (
      filters.updated_before !== undefined &&
      !(row.updated_at < filters.updated_before)
    )
      return false;
    return sourceFilterIncludesItem(filters.source_filter, row);
  });
  const sign = direction === "asc" ? 1 : -1;
  return kept.sort(
    (a, b) => sign * (compare(a[column], b[column]) || compare(a.id, b.id)),
  );
}

async function walk(filters: ItemFilters): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await storage.items.list({ ...filters, limit: PAGE, cursor });
    ids.push(...page.data.map((item) => item.id));
    if (page.next_cursor === null) return ids;
    cursor = page.next_cursor;
  }
  throw new Error("a listing never ended");
}

const BASE = instant(4);
const LATER = instant(9);

const CASES: Record<string, ItemFilters> = {
  "no filter": {},
  "an empty type, which is no filter": { type: "" },
  "a type with subtypes": { type: "user.docs" },
  "a subtree wildcard": { type: "user.docs.*" },
  "a leaf type": { type: "user.docs.b.deep" },
  "a type with nothing stored": { type: "user.nothing" },
  "a type and a state": { type: "user.docs", state: "archived" },
  "a type and a tier": { type: "user.docs", tier: "feed" },
  "a type and a source": { type: "user.docs", source: "one" },
  "a type and a source filter": {
    type: "user.docs",
    source_filter: { types: ["user.docs.b"], sources: ["one"] },
  },
  "a source filter on everything": {
    source_filter: { types: ["*"], sources: ["two"] },
  },
  "a type and occurred bounds": {
    type: "user.docs",
    occurred_after: BASE,
    occurred_before: LATER,
  },
  "a type and an updated bound": {
    type: "user.docs",
    updated_before: LATER,
  },
  "grants of a subtree and a name": {
    allowed_types: ["user.docs.*", "user.other"],
  },
  "grants with an exclusion": {
    allowed_types: ["user.docs.*", "user.other"],
    excluded_types: ["user.docs.b.*"],
  },
  "grants of names only": {
    allowed_types: ["user.docs.a", "user.docs.ghost", "user.decl"],
  },
  "grants of everything with an exclusion": {
    allowed_types: ["*"],
    excluded_types: ["user.docs.*"],
  },
  "grants and a type": {
    type: "user.docs",
    allowed_types: ["user.docs.b.*", "user.decl"],
  },
  "grants and a type with an exclusion": {
    type: "user.docs",
    allowed_types: ["user.docs.*", "user.decl"],
    excluded_types: ["user.docs.a"],
  },
  "system types excluded": { exclude_system_types: true },
  "everything under the namespace root": { type: "user.*" },
  "the global wildcard": { type: "*" },
};

const SORTS = ["created_at", "updated_at", "occurred_at"] as const;
const DIRECTIONS = ["desc", "asc"] as const;

describe("a listing in a system order", () => {
  it("has rows of every kind the cases below depend on", () => {
    expect(new Set(ALL.map((row) => row.created_at)).size).toBeLessThan(15);
    expect(
      expected({ type: "user.docs" }).some((row) => row.type === "user.decl"),
    ).toBe(true);
    expect(
      expected({ type: "user.docs" }).some(
        (row) => row.type === "user.docs.zz.deep",
      ),
    ).toBe(true);
    expect(
      expected({ type: "user.docs" }).some((row) => row.type === "user.docsx"),
    ).toBe(false);
  });

  for (const [name, filters] of Object.entries(CASES)) {
    for (const sort of SORTS) {
      for (const direction of DIRECTIONS) {
        it(`pages ${name}, ${sort} ${direction}, in the order of every stored row`, async () => {
          const query = { ...filters, sort, direction };
          expect(await walk(query)).toEqual(
            expected(query).map((row) => row.id),
          );
        });
      }
    }
  }

  it("continues from a cursor taken at any row, ties included", async () => {
    const filters: ItemFilters = {
      type: "user.docs",
      excluded_types: ["user.docs.a"],
      allowed_types: ["user.docs.*", "user.decl"],
    };
    for (const sort of SORTS) {
      for (const direction of DIRECTIONS) {
        const query = { ...filters, sort, direction };
        const all = expected(query);
        const key = cursorSortKey(
          "items",
          { kind: "system", column: sort },
          direction,
        );
        for (let at = 0; at < all.length - 1; at += 3) {
          const row = all[at]!;
          const page = await storage.items.list({
            ...query,
            limit: PAGE,
            cursor: encodeKeyedCursor(row[sort], row.id, key),
          });
          expect({
            sort,
            direction,
            at,
            ids: page.data.map((i) => i.id),
          }).toEqual({
            sort,
            direction,
            at,
            ids: all.slice(at + 1, at + 1 + PAGE).map((r) => r.id),
          });
        }
      }
    }
  });

  it("walks a catch-up from a point in time in updated order, ties included", async () => {
    for (const filters of [
      { updated_after: BASE },
      { updated_after: BASE, type: "user.docs" },
      { updated_after: BASE, allowed_types: ["user.docs.*", "user.decl"] },
      { updated_after: BASE, state: "archived" as const, type: "user.docs" },
    ] satisfies ItemFilters[]) {
      const ids = await walk(filters);
      expect(ids).toEqual(expected(filters).map((row) => row.id));
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  it("answers a page the same whatever its page size", async () => {
    const query: ItemFilters = { type: "user.docs", direction: "asc" };
    const whole = expected(query).map((row) => row.id);
    for (const limit of [1, 2, 5, 50, 1000]) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await storage.items.list({ ...query, limit, cursor });
        ids.push(...page.data.map((item) => item.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      expect({ limit, ids }).toEqual({ limit, ids: whole });
    }
  });

  it("reads a type nothing registered covers, between registered ones", async () => {
    const ids = await walk({ type: "user.docs.b" });
    expect(ids.some((id) => id.startsWith("user.docs.b.deep#"))).toBe(true);
    expect(ids.some((id) => id.startsWith("user.docs.ghost#"))).toBe(false);
    const ghost = await walk({ type: "user.docs.ghost" });
    expect(ghost).toEqual(
      expected({ type: "user.docs.ghost" }).map((row) => row.id),
    );
    expect(ghost.length).toBeGreaterThan(0);
  });
});
