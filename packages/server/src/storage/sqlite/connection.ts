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

/**
 * What an operator can do about a database this build will not open, and it
 * is deliberately not "export it and load it here".
 *
 * That was the advice until the archive format moved with the registry
 * rename: an export taken by the build that wrote such a database is a
 * version 1 archive, and `POST /admin/restore-archive` refuses version 1.
 * Naming a recovery that ends in a `400` is worse than naming none, so the
 * sentence says what is true — the file belongs to the build that wrote it,
 * and nothing here reads it.
 */
const REFUSED_DATABASE_REMEDY =
  "Nothing is upgraded in place and no export taken from it can be loaded here, so this file is " +
  "readable only by the build that wrote it. Keep it with that build if you need what is in it, " +
  "point this server at a fresh file, or discard it.";

/**
 * Columns whose absence means the file predates a rename, checked by table
 * so a fresh database — which has neither table yet — is not refused.
 *
 * **A refusal here must not be reachable through the API**, and that is the
 * rule rather than a property these three happen to have. Nothing a caller
 * can send creates a `custom_types` table, a `space_config` settings row or
 * a missing column, so each of these refuses a database an older build wrote
 * and nothing else. A refusal keyed on row *content* is a different animal:
 * one keyed on the retired `integration:` provenance prefix stood here
 * briefly, and because a caller could mint a credential carrying that source,
 * a single request could leave an instance that never opened again — with
 * the refusal telling its operator to discard the database. A boot check
 * whose trigger a request can write is a denial of service with a polite
 * message.
 *
 * **Every renamed column belongs here, not only the indexed ones.** An
 * earlier draft of this list reasoned that a column an index is built over
 * fails the DDL anyway, so only those need naming. That is true and it is
 * the wrong conclusion: a column nothing indexes passes the DDL silently,
 * because `CREATE TABLE IF NOT EXISTS` no-ops against the old table and a
 * CHECK constraint is never re-evaluated. The boot then succeeds, `GET /`
 * answers 200, and the first read of that column throws — for
 * `api_keys.permissions` that read is in the bearer middleware, so every
 * authenticated request on the instance answers `500 internal_error` after
 * a boot that said nothing was wrong.
 */
const RENAMED_COLUMNS: readonly (readonly [string, string])[] = [
  ["items", "occurred_at"],
  ["audit_log", "created_at"],
  ["api_keys", "permissions"],
  ["types", "owner_connector"],
];

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

  // A database still carrying the retired registry tables is refused, not
  // migrated.
  //
  // The schema is applied with CREATE TABLE IF NOT EXISTS, so renaming a
  // table does not move its rows: it creates an empty one beside the full
  // one, and every reader then sees an empty registry. Nothing about that
  // is loud. A previously registered type answers `unknown_type`, the
  // metrics count reads zero, the consent screen offers no publisher root,
  // and re-registering the same identifier succeeds against the new table
  // rather than conflicting — so the only place to catch it is here, before
  // the first read.
  //
  // **Ahead of the PRAGMAs, which is not fussiness.** `journal_mode = WAL`
  // rewrites the file header, so a refused database that had been probed
  // after it would come back altered by a boot that did nothing else. This
  // query needs neither PRAGMA, so the refusal happens while the file is
  // still untouched, and the client is closed on the way out.
  const retired = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('custom_types', 'custom_edge_types') ORDER BY name",
  );
  if (retired.rows.length > 0) {
    const names = retired.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string")
      .join(" and ");
    client.close();
    throw new Error(
      `The type registry in ${sqlitePath} is still held in ${names}, which this build does not read. ` +
        REFUSED_DATABASE_REMEDY,
    );
  }

  // A renamed column is refused here for the same reason, and the reason is
  // not that the old database would be read wrongly — it would not. The DDL
  // below creates an index over the new column, so an old file fails at that
  // statement whatever this does.
  //
  // What it fails with is the problem. A raw driver error naming an index
  // says nothing an operator can act on, and it arrives after the PRAGMAs,
  // which is the write the refusal above is ordered ahead of precisely so a
  // database this build will not open comes back unchanged. Refusing here
  // keeps both properties: one sentence that names the file and what to do,
  // and a file left as it was found.
  for (const [table, column] of RENAMED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (info.rows.length === 0) continue;
    const hasColumn = info.rows.some((row) => row.name === column);
    if (hasColumn) continue;
    client.close();
    throw new Error(
      `The ${table} table in ${sqlitePath} has no ${column} column, so it predates this build's schema. ` +
        REFUSED_DATABASE_REMEDY,
    );
  }

  // A retired settings key is refused on the same terms, and it is the
  // quietest of the three by some way.
  //
  // The instance configuration moved from the row keyed `space_config` to
  // one keyed `instance_config`. Nothing about that fails: the table is
  // there, the column is there, the read simply finds no row and answers an
  // empty object, so the enforcement levers and the cleanup-job retention
  // overrides an operator set are replaced by this build's defaults without
  // a line in the log. A database keeping records longer than the default
  // would start deleting them on the first sweep after an upgrade.
  //
  // The column is probed rather than named, for the reason the sibling check
  // above gives: a `settings` table of some other shape would otherwise meet
  // a `SELECT key` it cannot answer and die with a driver error carrying
  // neither the file nor a remedy, which is the failure this whole block
  // exists to convert into one sentence.
  const settingsInfo = await client.execute("PRAGMA table_info(settings)");
  const settingsHasKey = settingsInfo.rows.some((row) => row.name === "key");
  if (settingsHasKey) {
    const retiredSettings = await client.execute(
      "SELECT key FROM settings WHERE key IN ('space_config') ORDER BY key",
    );
    if (retiredSettings.rows.length > 0) {
      const keys = retiredSettings.rows
        .map((row) => row.key)
        .filter((key): key is string => typeof key === "string")
        .join(" and ");
      client.close();
      throw new Error(
        `The settings in ${sqlitePath} are still keyed ${keys}, which this build does not read. ` +
          REFUSED_DATABASE_REMEDY,
      );
    }
  }

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
        REFUSED_DATABASE_REMEDY,
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
