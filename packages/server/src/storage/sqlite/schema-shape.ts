import { readFileSync } from "node:fs";
import { createClient, type InStatement, type ResultSet } from "@libsql/client";

/**
 * The database's DDL, generated from `schema.ts` by
 * `scripts/generate-schema-sql.ts` and applied in full at every open.
 * Read from beside this module so the same file serves `tsx` on the source
 * tree and the built bundle, which copies it into `dist/`.
 */
export const SCHEMA_SQL = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);

// Raw SQL for tables that Drizzle cannot express (FTS5 virtual tables).
// `tags` carries the sidecar's tag list, space-joined, so a tag absent from
// an item's text still finds it; the search store keeps the column current
// on every tag write.
export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  body,
  description,
  name,
  extra,
  tags,
  tokenize='porter unicode61'
);
`;

/** What reads a database: a client, or a transaction on one. */
export interface Reader {
  execute(stmt: InStatement): Promise<ResultSet>;
}

interface SchemaObject {
  type: string;
  table: string;
  sql: string | null;
}

/** A schema as SQLite stored it, and a private database that holds it. */
export interface Shape {
  reader: Reader;
  objects: Map<string, SchemaObject>;
}

/** Every table, index and trigger in the database, by name. */
async function schemaObjects(db: Reader): Promise<Map<string, SchemaObject>> {
  const rows = await db.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')",
  );
  const out = new Map<string, SchemaObject>();
  for (const row of rows.rows) {
    const { type, name, tbl_name: table, sql } = row;
    if (typeof name !== "string" || typeof type !== "string") continue;
    if (typeof table !== "string") continue;
    out.set(name, {
      type,
      table,
      sql: typeof sql === "string" ? sql : null,
    });
  }
  return out;
}

async function columnNames(db: Reader, table: string): Promise<Set<string>> {
  const info = await db.execute(
    `PRAGMA table_info(\`${table.replaceAll("`", "``")}\`)`,
  );
  return new Set(
    info.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

/**
 * The schema that `build` creates, read back from a private in-memory
 * database it was applied to, so a comparison is against what SQLite stored
 * for the DDL and not against a hand-kept list.
 */
export async function shapeOf(
  build: (db: {
    execute(stmt: InStatement): Promise<ResultSet>;
    executeMultiple(sql: string): Promise<void>;
  }) => Promise<void>,
): Promise<Shape> {
  const client = createClient({ url: ":memory:" });
  await build(client);
  return { reader: client, objects: await schemaObjects(client) };
}

let current: Promise<Shape> | undefined;

/** The schema this build creates. */
export function currentShape(): Promise<Shape> {
  current ??= shapeOf(async (db) => {
    await db.executeMultiple(SCHEMA_SQL);
    await db.executeMultiple(CREATE_FTS);
  });
  return current;
}

/** The name prefix of each virtual table's shadow tables. */
export function shadowTablePrefixes(
  objects: Map<string, SchemaObject>,
): string[] {
  return [...objects]
    .filter(([, o]) => o.sql?.startsWith("CREATE VIRTUAL TABLE") === true)
    .map(([name]) => `${name}_`);
}

/**
 * The tables of a shape whose rows are its own: every table it declares,
 * the full-text table among them, but no virtual table's shadow tables,
 * which SQLite fills from the virtual table's rows.
 */
export function ownTables(shape: Shape): string[] {
  const shadow = shadowTablePrefixes(shape.objects);
  return [...shape.objects]
    .filter(
      ([name, object]) =>
        object.type === "table" &&
        !name.startsWith("sqlite_") &&
        !shadow.some((prefix) => name.startsWith(prefix)),
    )
    .map(([name]) => name);
}

/**
 * How the file's schema differs from `shape`, one phrase per object, or
 * none when every table, index and trigger the shape declares and the file
 * holds is the one the shape holds. The tables a file lacks are returned
 * apart, because whether that is a difference depends on what the file
 * holds: only a file holding any of the shape's tables is asked, since a new
 * file holds none.
 *
 * **Every difference, because `IF NOT EXISTS` hides every difference.** A
 * missing column fails on the first read of it, a column this build no
 * longer writes fails the first insert when it was `NOT NULL`, and a
 * changed default or CHECK fails the first write that leans on it; the
 * boot says nothing about any of them. Comparing the stored DDL catches
 * all of these without a list someone must remember to extend. The stored
 * text is compared as SQLite keeps it, so a migration has to leave the text
 * `schema.sql` would have made: `ALTER TABLE` rewrites it, and is caught
 * here as a difference.
 *
 * A table the shape does not declare is not compared, since a replication
 * sidecar keeps its own tables in the file. Nothing a request can send
 * creates or alters a table, an index or a trigger, so no caller can make
 * this refuse an instance.
 */
export async function schemaDifferences(
  db: Reader,
  shape: Shape,
): Promise<{ differences: string[]; missingTables: string[] }> {
  const found = await schemaObjects(db);
  const differences: string[] = [];
  // A virtual table's shadow tables are SQLite's to shape and may change
  // with the library; the virtual table's own DDL is what this build chose.
  const shadowPrefixes = shadowTablePrefixes(shape.objects);
  for (const [name, object] of found) {
    if (shadowPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const expected = shape.objects.get(name);
    if (expected === undefined) {
      if (shape.objects.get(object.table)?.type === "table") {
        differences.push(
          `there is a ${name} ${object.type} on the ${object.table} table this build does not declare`,
        );
      }
      continue;
    }
    if (expected.type === object.type && expected.sql === object.sql) continue;
    if (expected.type !== "table" || object.type !== "table") {
      differences.push(`the ${name} ${object.type} differs from this build's`);
      continue;
    }
    const want = await columnNames(shape.reader, name);
    const have = await columnNames(db, name);
    const missing = [...want].filter((column) => !have.has(column));
    const extra = [...have].filter((column) => !want.has(column));
    if (missing.length > 0) {
      differences.push(`the ${name} table lacks ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      differences.push(
        `the ${name} table has ${extra.join(", ")}, which this build does not declare`,
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      differences.push(
        `the ${name} table differs from this build's definition of it`,
      );
    }
  }
  // A table the shape declares and the file lacks would be created empty by
  // the DDL, so a file written before the table existed opens with an index
  // or a log that silently describes none of its rows.
  const missingTables: string[] = [];
  const holdsThisShape = [...found.keys()].some(
    (name) => shape.objects.get(name)?.type === "table",
  );
  if (holdsThisShape) {
    for (const [name, object] of shape.objects) {
      if (object.type !== "table" || found.has(name)) continue;
      if (name.startsWith("sqlite_")) continue;
      // The full-text table is applied apart from `schema.sql`, so its
      // absence is no sign of which build wrote the file.
      if (object.sql?.startsWith("CREATE VIRTUAL TABLE") === true) continue;
      if (shadowPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      missingTables.push(name);
    }
  }
  return { differences, missingTables };
}

/**
 * The tables the database holds that one of `others` declares and `shape`
 * does not: a sign the file is at another version than `shape`'s, which
 * `schemaDifferences` does not see, because it passes over every table
 * `shape` does not declare.
 */
export async function tablesOfOtherShapes(
  db: Reader,
  shape: Shape,
  others: readonly Shape[],
): Promise<string[]> {
  const found = await schemaObjects(db);
  const own = new Set(ownTables(shape));
  const known = new Set(others.flatMap((other) => ownTables(other)));
  return [...found]
    .filter(
      ([name, object]) =>
        object.type === "table" && known.has(name) && !own.has(name),
    )
    .map(([name]) => name);
}

/** Of `tables`, those the database holds. */
export async function presentTables(
  db: Reader,
  tables: readonly string[],
): Promise<string[]> {
  const found = await schemaObjects(db);
  return tables.filter((name) => found.get(name)?.type === "table");
}

/** Whether the database holds any of the tables `shape` declares. */
export async function holdsAnyTable(
  db: Reader,
  shape: Shape,
): Promise<boolean> {
  const found = await schemaObjects(db);
  return ownTables(shape).some((name) => found.has(name));
}

/**
 * Whether any of the shape's tables in the database holds a row.
 *
 * A table the shape does not declare is not read: a replication sidecar
 * keeps its own tables in the file and writes rows to them whatever state
 * this build's tables are in.
 */
export async function holdsRows(db: Reader, shape: Shape): Promise<boolean> {
  const found = await schemaObjects(db);
  for (const name of ownTables(shape)) {
    if (!found.has(name)) continue;
    const rows = await db.execute(
      `SELECT 1 FROM \`${name.replaceAll("`", "``")}\` LIMIT 1`,
    );
    if (rows.rows.length > 0) return true;
  }
  return false;
}

/** The number of rows in each of `tables`. */
export async function rowCounts(
  db: Reader,
  tables: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const result = await db.execute(
      `SELECT count(*) AS n FROM \`${table.replaceAll("`", "``")}\``,
    );
    counts.set(table, Number(result.rows[0]?.n ?? 0));
  }
  return counts;
}
