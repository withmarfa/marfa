/**
 * The SQL compilers for a type and their JavaScript twins answer alike, run
 * against SQLite rather than read as text: the type map (`typeFilterSql` and
 * `matchesTypeFilter`, and the point check `resolveTypePermission`), the
 * `?type=` read filter (`typeSubtreeSql` and `typeAnswersSubtreeFilter`) and
 * the source filter (`sourceFilterToSql` and `sourceFilterIncludesItem`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql, type SQL } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  matchesTypeFilter,
  registerTypeSchema,
  resolveTypePermission,
  typeAnswersSubtreeFilter,
  unregisterTypeSchema,
  type TypePermission,
  type TypeSchema,
} from "@withmarfa/shared";
import {
  sourceFilterIncludesItem,
  sourceFilterToSql,
  typeFilterSql,
  typeSubtreeSql,
} from "./filter-sql.js";

const rows = sqliteTable("rows", {
  type: text("type").notNull(),
  source: text("source").notNull(),
});

const TYPES = [
  "core.media",
  "core.media.book",
  "core.media.film",
  "core.mediation",
  "core.note",
  "core.note.private",
  "user.secret",
  "user.diary",
  "user.declared_note",
  "acme.thing",
  "Core.note",
  "core.note?x",
];
const SOURCES = ["one", "two", "a?b"];

const client = createClient({ url: ":memory:" });
const db = drizzle(client);

beforeAll(async () => {
  await client.execute(
    "CREATE TABLE rows (type TEXT NOT NULL, source TEXT NOT NULL)",
  );
  for (const type of TYPES) {
    for (const source of SOURCES) {
      await client.execute({
        sql: "INSERT INTO rows VALUES (?, ?)",
        args: [type, source],
      });
    }
  }
});
afterAll(() => {
  client.close();
});

/** The rows a predicate admits, as `type|source`, sorted. */
async function admitted(predicate: SQL | undefined): Promise<string[]> {
  const selected = await db.all<{ type: string; source: string }>(
    sql`SELECT type, source FROM rows WHERE ${predicate ?? sql`1=1`}`,
  );
  return selected.map((r) => `${r.type}|${r.source}`).sort();
}

function every(test: (type: string, source: string) => boolean): string[] {
  return TYPES.flatMap((type) =>
    SOURCES.filter((source) => test(type, source)).map(
      (source) => `${type}|${source}`,
    ),
  ).sort();
}

describe("the type map", () => {
  const PATTERNS = [
    "*",
    "core.*",
    "core.media.*",
    "core.media.book",
    "user.*",
    "user.secret",
    "Core.note",
    "core.note?x",
  ];
  const LEVELS = ["absent", "read", "none"] as const;

  /** Every map over the patterns, at the read level and a `none`. */
  function maps(): Record<string, TypePermission>[] {
    let all: Record<string, TypePermission>[] = [{}];
    for (const pattern of PATTERNS) {
      all = all.flatMap((map) =>
        LEVELS.map((level) =>
          level === "absent" ? map : { ...map, [pattern]: level },
        ),
      );
    }
    return all;
  }

  it("selects in SQL what the list predicate and the point check admit, for every map", async () => {
    const all = maps();
    expect(all).toHaveLength(LEVELS.length ** PATTERNS.length);
    for (const map of all) {
      const allowed = Object.keys(map).filter((p) => map[p] !== "none");
      const excluded = Object.keys(map).filter((p) => map[p] === "none");
      const filter = { allowed, excluded };
      const inSql = await admitted(typeFilterSql(rows.type, filter));
      expect({ map, rows: inSql }).toEqual({
        map,
        rows: every((type) => matchesTypeFilter(type, filter)),
      });
      expect({ map, rows: inSql }).toEqual({
        map,
        rows: every((type) => resolveTypePermission(type, map) !== "none"),
      });
    }
  });

  it("restricts nothing for no credential and nothing at all for an empty grant", async () => {
    expect(
      typeFilterSql(rows.type, { allowed: undefined, excluded: [] }),
    ).toBeUndefined();
    expect(
      await admitted(typeFilterSql(rows.type, { allowed: [], excluded: [] })),
    ).toEqual([]);
  });

  it("emits no predicate for a global grant nothing carves into, and one for a carved grant", async () => {
    expect(
      typeFilterSql(rows.type, { allowed: ["*"], excluded: [] }),
    ).toBeUndefined();
    const carved = typeFilterSql(rows.type, {
      allowed: ["*"],
      excluded: ["user.*"],
    });
    expect(carved).toBeDefined();
    expect(await admitted(carved)).toEqual(
      every((type) => !type.startsWith("user.")),
    );
  });
});

describe("the ?type= read filter", () => {
  const OUTSIDE = "user.declared_note";
  afterEach(() => {
    unregisterTypeSchema(OUTSIDE);
  });

  it("selects in SQL what the stream's predicate admits, by name and by declared parent", async () => {
    registerTypeSchema({
      id: OUTSIDE,
      name: OUTSIDE,
      description: "test",
      parent: "core.note",
      version: 1,
      fields: {},
    } as unknown as TypeSchema);
    for (const filter of [
      "core.note",
      "core.note.*",
      "core.media",
      "core.media.*",
      "core",
      "*",
      "user.*",
    ]) {
      expect({
        filter,
        rows: await admitted(typeSubtreeSql(rows.type, filter)),
      }).toEqual({
        filter,
        rows: every((type) => typeAnswersSubtreeFilter(type, filter)),
      });
    }
    expect(await admitted(typeSubtreeSql(rows.type, "core.note"))).toContain(
      `${OUTSIDE}|one`,
    );
  });
});

describe("the source filter", () => {
  it("selects in SQL what its predicate admits", async () => {
    for (const filter of [
      { types: ["core.note"], sources: ["one"] },
      { types: ["core.media.*"], sources: ["one", "a?b"] },
      { types: ["*"], sources: ["two"] },
      { types: ["core.note", "user.secret"], sources: [] },
      { types: [], sources: ["one"] },
    ]) {
      expect({
        filter,
        rows: await admitted(sourceFilterToSql(filter, rows.type, rows.source)),
      }).toEqual({
        filter,
        rows: every((type, source) =>
          sourceFilterIncludesItem(filter, { type, source }),
        ),
      });
    }
  });
});
