import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";

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
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id,
  title,
  body,
  description,
  name,
  extra,
  tags,
  tokenize='porter unicode61'
);
`;

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
export type RawDb = Client;

/**
 * Translate a filesystem path or `:memory:` into the URL shape libsql expects.
 *
 * - `":memory:"` becomes `"file::memory:?cache=shared"` so multiple logical
 *   connections (e.g. the writer connection an interactive transaction holds)
 *   share one in-memory database. Plain `:memory:` gives each libsql logical
 *   connection its own isolated DB, which breaks the moment a transaction
 *   opens — the tx connection sees a different empty database.
 * - File paths become `file:<path>`; an already-formed `file:` URL passes.
 *
 * One file per instance, and nothing else: a remote libsql URL would open
 * and then silently ignore every PRAGMA below, so it is not an option here.
 */
function toLibsqlUrl(pathOrUrl: string): string {
  if (pathOrUrl === ":memory:") return "file::memory:?cache=shared";
  if (pathOrUrl.startsWith("file:")) return pathOrUrl;
  return `file:${pathOrUrl}`;
}

/**
 * Opens a libsql connection, enables WAL mode, creates all tables
 * (idempotent), and returns both the Drizzle db and the raw libsql client.
 */
export async function createConnection(sqlitePath: string): Promise<{
  db: DrizzleDb;
  raw: RawDb;
  close: () => Promise<void>;
}> {
  // Ensure the directory exists for filesystem paths (skip for in-memory and
  // an already-formed `file:` URL).
  if (sqlitePath !== ":memory:" && !sqlitePath.startsWith("file:")) {
    const dir = dirname(sqlitePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const client = createClient({ url: toLibsqlUrl(sqlitePath) });

  // Enable WAL for better concurrent read/write performance. PRAGMA is a
  // no-op on libsql remote URLs but harmless.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  // Create tables via raw SQL (idempotent — CREATE TABLE IF NOT EXISTS).
  await client.executeMultiple(SCHEMA_SQL);
  // The remaining hand-written block is the FTS5 virtual table — drizzle-kit
  // cannot express FTS5, so it is applied separately.
  await client.executeMultiple(CREATE_FTS);

  // An index that predates the schema is refused, not repaired.
  //
  // This rebuilt it: dropped the table and re-indexed every row. That is an
  // in-place upgrade of an old database, and the decisions in force allow
  // none — nothing is upgraded, an old instance is exported through the API
  // or discarded. Repairing on open is also the shape that hides the
  // problem, because it runs silently on every boot and a half-finished
  // re-index leaves a search index nobody knows is partial.
  //
  // **The remedy names the previous build deliberately.** This throw is on
  // the open path, so the server that would serve `GET /export` cannot
  // start; telling an operator to export through the API from here would
  // name an action the refusal itself has taken away.
  //
  // FTS5 has no ALTER TABLE, so probing for the column is the only way to
  // tell an index of this shape from an older one. Only a missing column
  // means "older": anything else — corruption, a locked file, an I/O error
  // — is a different problem and is rethrown with its own message, because
  // reporting those as staleness would tell an operator to discard a
  // database that is merely unreadable this second.
  const probe = await client.execute("SELECT tags FROM items_fts LIMIT 0").then(
    () => null,
    (err: unknown) =>
      err instanceof Error ? err : new Error(JSON.stringify(err)),
  );
  if (probe !== null) {
    if (!/no such column/i.test(probe.message)) throw probe;
    throw new Error(
      `The full-text index in ${sqlitePath} predates the current schema, and nothing is upgraded in place. ` +
        "Export the instance with the build it was last opened by, then load that export into a fresh " +
        "instance on this one — or discard it.",
      { cause: probe },
    );
  }

  const db = drizzle(client, { schema });

  return {
    db,
    raw: client,
    close: async () => {
      client.close();
    },
  };
}

export { sql };
