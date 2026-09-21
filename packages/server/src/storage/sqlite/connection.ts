import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type TransactionMode,
} from "@libsql/client";
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
 * is deliberately not "export it and load it here": an export taken by the
 * build that wrote such a database is a version 1 archive, which
 * `POST /admin/restore-archive` refuses. Naming a recovery that ends in a
 * `400` is worse than naming none, so the sentence says what is true: the
 * file belongs to the build that wrote it, and nothing here reads it.
 */
const REFUSED_DATABASE_REMEDY =
  "Nothing is upgraded in place and no export taken from it can be loaded here, so this file is " +
  "readable only by the build that wrote it. Keep it with that build if you need what is in it, " +
  "point this server at a fresh file, or discard it.";

/**
 * Columns whose absence means the file predates a rename, checked by table
 * so a fresh database — which has none of these tables yet — is not refused.
 *
 * **A refusal here must not be reachable through the API**, and that is the
 * rule rather than a property these checks happen to have. Nothing a caller
 * can send creates a `custom_types` table, a `space_config` settings row or
 * a missing column, so each of these refuses a database an older build wrote
 * and nothing else. A refusal keyed on row *content* is a different animal:
 * a caller can mint a credential carrying the retired `integration:` source
 * prefix, so a check keyed on it would let a single request leave an
 * instance that never opened again, with the refusal telling its operator
 * to discard the database. A boot check whose trigger a request can write
 * is a denial of service with a polite message.
 *
 * **Every renamed column belongs here, not only the indexed ones.** A
 * column an index is built over fails the DDL anyway, which is true and
 * the wrong conclusion: a column nothing indexes passes the DDL silently,
 * because `CREATE TABLE IF NOT EXISTS` no-ops against the old table and a
 * CHECK constraint is never re-evaluated. The boot then succeeds, `GET /`
 * answers 200, and the first read of that column throws — for
 * `api_keys.permissions` that read is in the bearer middleware, so every
 * authenticated request on the instance answers `500 internal_error` after
 * a boot that said nothing was wrong.
 *
 * **The third name is a witness, and it is why `blobs` can be on this list.**
 * A table name alone is not evidence the file is one of ours: `blobs` in
 * particular is a name anything might use, and refusing a stranger's
 * database with advice about a build that never wrote it is worse than
 * opening it. So each entry also names a column this build's table has and
 * an unrelated one would not, and the check concludes nothing unless the
 * witness is present. The sibling `settings` probe reached the same answer
 * from the other direction, and says so in its own test: recognizing a
 * stranger's schema is not this check's job.
 */
const RENAMED_COLUMNS: readonly (readonly [string, string, string])[] = [
  ["items", "occurred_at", "source_id"],
  ["audit_log", "created_at", "resource_type"],
  ["api_keys", "permissions", "is_operator"],
  ["types", "owner_connector", "origin"],
  ["blobs", "size_bytes", "mime_type"],
  ["outbound_webhook_deliveries", "event_type", "webhook_secret"],
];

/**
 * The opposite shape of the list above, and it exists for the same reason.
 *
 * A column this build no longer declares passes `CREATE TABLE IF NOT EXISTS`
 * exactly as a missing one does, and where the retired column was `NOT NULL`
 * the boot then succeeds and the first insert fails with a constraint error
 * naming a column the schema does not declare. Same triple as above: the
 * table, the column that must be absent, and a witness that says the table
 * is ours.
 */
const RETIRED_COLUMNS: readonly (readonly [string, string, string])[] = [
  ["blobs", "storage_path", "mime_type"],
];

/**
 * How long a statement refused with `SQLITE_BUSY` is retried before the
 * refusal stands: longer than any write transaction the server opens or
 * any checkpoint a sidecar takes on the file, short enough that a lock a
 * stuck process holds surfaces as an error rather than a hang.
 */
const BUSY_BUDGET_MS = 5_000;
/** The first wait between tries, doubled up to the cap: a lock held for a
 *  millisecond costs a millisecond, and one held for seconds is not asked
 *  about a thousand times. */
const BUSY_RETRY_MIN_MS = 1;
const BUSY_RETRY_MAX_MS = 50;

function isBusy(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Run `attempt` until it is not refused with `SQLITE_BUSY` or the budget
 * is spent, sleeping on the event loop between tries.
 *
 * The sleep is the point, and it is why libsql's own `timeout` option is
 * not used. That option waits inside the native call, which holds the
 * whole process: nothing else runs, the lock's holder included, when the
 * holder is a transaction of this same process sitting between two of its
 * statements. That is the ordinary shape of contention here, because the
 * housekeeping scheduler starts runs beside the request path and a run's
 * transaction interleaves with the next claim. With the native wait such
 * a writer stops the server for the whole timeout and then fails anyway;
 * with a sleep the holder reaches its commit and the retry succeeds. A
 * lock another process holds, a sidecar's checkpoint, frees on its own
 * either way. Exported for its test.
 */
export async function untilNotBusy<T>(
  attempt: () => Promise<T>,
  budgetMs = BUSY_BUDGET_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let wait = BUSY_RETRY_MIN_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!isBusy(err) || remaining <= 0) throw err;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(wait, remaining));
      });
      wait = Math.min(wait * 2, BUSY_RETRY_MAX_MS);
    }
  }
}

/**
 * The client with every entry point that can meet the write lock retried
 * under `untilNotBusy`: a statement, a batch, the `BEGIN IMMEDIATE` a
 * transaction opens with, and a script. A statement issued inside an open
 * transaction already holds the lock and goes through the transaction
 * object as it is.
 *
 * Two more things the wrapper does, because of what a refused statement
 * leaves behind. A connection whose statement was refused with
 * `SQLITE_BUSY` is not sound afterwards: it holds a transaction nothing
 * can see or end, so a later write on it lands nowhere while answering
 * success, a later `BEGIN` on it fails, and every other connection is
 * refused the lock until it is closed. So a refusal drops the connection
 * (`reconnect()`) before anything else runs on it, and to make "before
 * anything else" true the client's calls are serialized: each waits for
 * the one before it to settle, which costs a microtask per statement and
 * no concurrency, since every statement here is synchronous inside the
 * native call anyway.
 */
function waitingForTheLock(client: Client): Client {
  let tail: Promise<unknown> = Promise.resolve();
  const one = <T>(attempt: () => Promise<T>): Promise<T> => {
    const turn = tail.then(
      () => discardingWhenBusy(client, attempt),
      () => discardingWhenBusy(client, attempt),
    );
    tail = turn.catch(() => undefined);
    return turn;
  };
  return {
    get closed() {
      return client.closed;
    },
    get protocol() {
      return client.protocol;
    },
    execute: (stmtOrSql: InStatement | string, args?: InArgs) =>
      untilNotBusy(() =>
        one(() =>
          typeof stmtOrSql === "string"
            ? client.execute(stmtOrSql, args)
            : client.execute(stmtOrSql),
        ),
      ),
    batch: (stmts, mode) =>
      untilNotBusy(() => one(() => client.batch(stmts, mode))),
    migrate: (stmts) => untilNotBusy(() => one(() => client.migrate(stmts))),
    transaction: (mode?: TransactionMode) =>
      untilNotBusy(() =>
        one(() =>
          mode === undefined ? client.transaction() : client.transaction(mode),
        ),
      ),
    executeMultiple: (sql) =>
      untilNotBusy(() => one(() => client.executeMultiple(sql))),
    sync: () => client.sync(),
    close: () => {
      client.close();
    },
    reconnect: () => {
      client.reconnect();
    },
  };
}

/** One call on the client, with the connection dropped if the lock refused
 *  it, inside the same turn so nothing else can run on it first. */
async function discardingWhenBusy<T>(
  client: Client,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (isBusy(err)) client.reconnect();
    throw err;
  }
}

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

  // No `timeout`: a statement that meets the write lock fails at once with
  // `SQLITE_BUSY`, and the wrapper retries it with the event loop free.
  // The wrapper rather than a `PRAGMA busy_timeout` for the same reason
  // the native option is not used, and because a pragma reaches one
  // connection while the transaction path opens its own.
  const client = waitingForTheLock(
    createClient({ url: toLibsqlUrl(sqlitePath) }),
  );

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
  for (const [table, column, witness] of RENAMED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (info.rows.length === 0) continue;
    const names = new Set(
      info.rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!names.has(witness)) continue;
    if (names.has(column)) continue;
    client.close();
    throw new Error(
      `The ${table} table in ${sqlitePath} has no ${column} column, so it predates this build's schema. ` +
        REFUSED_DATABASE_REMEDY,
    );
  }

  for (const [table, column, witness] of RETIRED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (info.rows.length === 0) continue;
    const names = new Set(
      info.rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!names.has(witness)) continue;
    if (!names.has(column)) continue;
    client.close();
    throw new Error(
      `The ${table} table in ${sqlitePath} still has a ${column} column, which this build does not write. ` +
        REFUSED_DATABASE_REMEDY,
    );
  }

  // A retired settings key is refused on the same terms, and it is the
  // quietest of these checks by some way.
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

  // WAL: readers do not block the writer, and it is what Litestream
  // replicates.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  // Create tables via raw SQL (idempotent — CREATE TABLE IF NOT EXISTS).
  await client.executeMultiple(SCHEMA_SQL);
  // The remaining hand-written block is the FTS5 virtual table — drizzle-kit
  // cannot express FTS5, so it is applied separately.
  await client.executeMultiple(CREATE_FTS);

  // An index that predates the schema is refused, not repaired. Rebuilding
  // it here would be an in-place upgrade of an old database, which the
  // decisions in force allow none of: an old instance is exported through
  // the API or discarded. Repairing on open is also the shape that hides
  // the problem, because it runs silently on every boot and a half-finished
  // re-index leaves a search index nobody knows is partial.
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
