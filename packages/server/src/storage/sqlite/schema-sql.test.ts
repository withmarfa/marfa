/**
 * `schema.sql` is what the database is built from; `schema.ts` is what the
 * code reads it through. The file is generated from the declarations, and
 * this holds the two together: a database built from the file is introspected
 * and compared, object by object, with what the declarations say. A
 * declaration changed without regenerating the file fails here, as does a
 * hand edit to the file.
 *
 * The FTS5 sidecar is declared in `connection.ts` and excluded, since it is
 * not a drizzle table and cannot be.
 */
import { createClient, type Client } from "@libsql/client";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { SCHEMA_SQL } from "./connection.js";

interface DeclaredIndex {
  unique: boolean;
  partial: boolean;
  /** Column names in order; `null` where the entry is an expression. */
  columns: (string | null)[];
}

interface DeclaredTable {
  columns: Map<
    string,
    { notNull: boolean; primary: boolean; dflt: string | null }
  >;
  indexes: Map<string, DeclaredIndex>;
  checks: Set<string>;
  foreignKeys: Set<string>;
}

/** The literal SQLite reports in `dflt_value` for a declared default. */
function defaultLiteral(value: unknown): string | null {
  if (value === undefined) return null;
  if (is(value, SQL)) return null;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value.toString();
  return null;
}

function declaredTables(): Map<string, DeclaredTable> {
  const out = new Map<string, DeclaredTable>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const compositePk = new Set(
      config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
    );
    const columns = new Map<
      string,
      { notNull: boolean; primary: boolean; dflt: string | null }
    >();
    const indexes = new Map<string, DeclaredIndex>();
    for (const column of config.columns) {
      columns.set(column.name, {
        notNull:
          column.notNull || column.primary || compositePk.has(column.name),
        primary: column.primary || compositePk.has(column.name),
        dflt: defaultLiteral(column.default),
      });
      // drizzle-kit renders a column-level `.unique()` as a named unique index.
      if (column.isUnique) {
        indexes.set(`${config.name}_${column.name}_unique`, {
          unique: true,
          partial: false,
          columns: [column.name],
        });
      }
    }
    for (const index of config.indexes) {
      indexes.set(index.config.name, {
        unique: index.config.unique,
        partial: index.config.where !== undefined,
        columns: index.config.columns.map((c) => (is(c, SQL) ? null : c.name)),
      });
    }
    const foreignKeys = new Set<string>();
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const foreign = getTableConfig(ref.foreignTable).name;
      ref.columns.forEach((column, i) => {
        foreignKeys.add(
          `${column.name}->${foreign}.${ref.foreignColumns[i]?.name ?? "?"}:${fk.onDelete ?? "no action"}`,
        );
      });
    }
    out.set(config.name, {
      columns,
      indexes,
      checks: new Set(config.checks.map((c) => c.name)),
      foreignKeys,
    });
  }
  return out;
}

async function introspect(client: Client): Promise<Map<string, DeclaredTable>> {
  const out = new Map<string, DeclaredTable>();
  const tables = await client.execute(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts%'`,
  );
  for (const row of tables.rows) {
    const name = row.name as string;
    const ddl = (row.sql as string | null) ?? "";
    const columns = new Map<
      string,
      { notNull: boolean; primary: boolean; dflt: string | null }
    >();
    for (const c of (await client.execute(`PRAGMA table_info("${name}")`))
      .rows) {
      columns.set(c.name as string, {
        notNull: Number(c.notnull) === 1 || Number(c.pk) > 0,
        primary: Number(c.pk) > 0,
        dflt: (c.dflt_value as string | null) ?? null,
      });
    }
    const indexes = new Map<string, DeclaredIndex>();
    for (const i of (await client.execute(`PRAGMA index_list("${name}")`))
      .rows) {
      // Autoindexes back inline PRIMARY KEY and UNIQUE clauses; the
      // declarations render those as columns, not as indexes.
      if (i.origin !== "c") continue;
      const iname = i.name as string;
      const info = await client.execute(`PRAGMA index_info("${iname}")`);
      indexes.set(iname, {
        unique: Number(i.unique) === 1,
        partial: Number(i.partial) === 1,
        columns: info.rows.map((r) => (r.name as string | null) ?? null),
      });
    }
    const foreignKeys = new Set<string>();
    for (const f of (await client.execute(`PRAGMA foreign_key_list("${name}")`))
      .rows) {
      foreignKeys.add(
        `${f.from as string}->${f.table as string}.${f.to as string}:${(f.on_delete as string).toLowerCase()}`,
      );
    }
    const checks = new Set(
      [...ddl.matchAll(/CONSTRAINT "([^"]+)" CHECK/g)].map((m) => m[1] ?? ""),
    );
    out.set(name, { columns, indexes, checks, foreignKeys });
  }
  return out;
}

describe("schema.sql matches schema.ts", () => {
  let client: Client;
  let built: Map<string, DeclaredTable>;
  const declared = declaredTables();

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.executeMultiple(SCHEMA_SQL);
    built = await introspect(client);
  });

  afterAll(() => {
    client.close();
  });

  it("declares something, so an empty comparison cannot pass", () => {
    expect(declared.size).toBeGreaterThan(10);
  });

  it("builds exactly the declared tables", () => {
    expect([...built.keys()].sort()).toEqual([...declared.keys()].sort());
  });

  it("gives every table the declared columns, nullability, keys and defaults", () => {
    for (const [name, table] of declared) {
      const actual = built.get(name);
      expect(actual, name).toBeDefined();
      expect([...actual!.columns.keys()].sort(), name).toEqual(
        [...table.columns.keys()].sort(),
      );
      for (const [column, shape] of table.columns) {
        expect(actual!.columns.get(column), `${name}.${column}`).toEqual(shape);
      }
    }
  });

  it("builds the declared indexes and no others", () => {
    for (const [name, table] of declared) {
      const actual = built.get(name)!;
      expect([...actual.indexes.keys()].sort(), name).toEqual(
        [...table.indexes.keys()].sort(),
      );
      for (const [iname, shape] of table.indexes) {
        const got = actual.indexes.get(iname)!;
        expect(got.unique, iname).toBe(shape.unique);
        expect(got.partial, iname).toBe(shape.partial);
        expect(got.columns.length, iname).toBe(shape.columns.length);
        shape.columns.forEach((column, i) => {
          if (column !== null) expect(got.columns[i], iname).toBe(column);
        });
      }
    }
  });

  it("carries the declared checks and foreign keys", () => {
    for (const [name, table] of declared) {
      const actual = built.get(name)!;
      expect([...actual.checks].sort(), name).toEqual([...table.checks].sort());
      expect([...actual.foreignKeys].sort(), name).toEqual(
        [...table.foreignKeys].sort(),
      );
    }
  });

  it("is idempotent, so a second open leaves an existing database alone", async () => {
    await client.executeMultiple(SCHEMA_SQL);
    expect(await introspect(client)).toEqual(built);
  });
});
