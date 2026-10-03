import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createClient,
  LibsqlError,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
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
 * is deliberately not "export it and load it here": whether the export the
 * writing build takes restores here depends on that build, which this one
 * cannot see. Naming a recovery that may end in a `400` is worse than naming
 * none, so the sentence says what is true: the file belongs to the build
 * that wrote it.
 */
const REFUSED_DATABASE_REMEDY =
  "Nothing is upgraded in place, so this file is readable only by the build that wrote it. " +
  "Keep it with that build if you need what is in it, point this server at a fresh file, or " +
  "discard it.";

interface SchemaObject {
  type: string;
  table: string;
  sql: string | null;
}

/** Every table, index and trigger in `client`'s file, by name. */
async function schemaObjects(
  client: Client,
): Promise<Map<string, SchemaObject>> {
  const rows = await client.execute(
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

async function columnNames(
  client: Client,
  table: string,
): Promise<Set<string>> {
  const info = await client.execute(
    `PRAGMA table_info(\`${table.replaceAll("`", "``")}\`)`,
  );
  return new Set(
    info.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

/**
 * The schema this build creates, read back from a private in-memory
 * database it was applied to, so the comparison below is against what
 * SQLite stored for this build's DDL and not against a hand-kept list.
 */
let reference:
  Promise<{ client: Client; objects: Map<string, SchemaObject> }> | undefined;

function referenceSchema() {
  reference ??= (async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(SCHEMA_SQL);
    await client.executeMultiple(CREATE_FTS);
    return { client, objects: await schemaObjects(client) };
  })();
  return reference;
}

/**
 * How the file's schema differs from this build's, one phrase per object,
 * or none when every table, index and trigger this build declares and the
 * file holds is the one this build would create, and a file holding any of
 * this build's tables holds them all.
 *
 * **Every difference, because `IF NOT EXISTS` hides every difference.** A
 * missing column fails on the first read of it, a column this build no
 * longer writes fails the first insert when it was `NOT NULL`, and a
 * changed default or CHECK fails the first write that leans on it; the
 * boot says nothing about any of them. Comparing the stored DDL catches
 * all of these without a list someone must remember to extend.
 *
 * A table this build does not declare is not compared, since a replication
 * sidecar keeps its own tables in the file. Nothing a request can send
 * creates or alters a table, an index or a trigger, so no caller can make
 * this refuse an instance.
 */
async function schemaDifferences(client: Client): Promise<string[]> {
  const ref = await referenceSchema();
  const found = await schemaObjects(client);
  const differences: string[] = [];
  // A virtual table's shadow tables are SQLite's to shape and may change
  // with the library; the virtual table's own DDL is what this build chose.
  const shadowPrefixes = [...ref.objects]
    .filter(([, o]) => o.sql?.startsWith("CREATE VIRTUAL TABLE") === true)
    .map(([name]) => `${name}_`);
  for (const [name, object] of found) {
    if (shadowPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const expected = ref.objects.get(name);
    if (expected === undefined) {
      if (ref.objects.get(object.table)?.type === "table") {
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
    const want = await columnNames(ref.client, name);
    const have = await columnNames(client, name);
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
  // A table this build declares and the file lacks would be created empty
  // by the DDL below, so a file written before the table existed opens with
  // an index or a log that silently describes none of its rows. Only a file
  // that already holds this build's tables is asked: a new file holds none.
  const holdsThisBuild = [...found.keys()].some(
    (name) => ref.objects.get(name)?.type === "table",
  );
  if (holdsThisBuild) {
    for (const [name, object] of ref.objects) {
      if (object.type !== "table" || found.has(name)) continue;
      if (name.startsWith("sqlite_")) continue;
      // The full-text table is applied apart from `schema.sql`, so its
      // absence is no sign of which build wrote the file.
      if (object.sql?.startsWith("CREATE VIRTUAL TABLE") === true) continue;
      if (shadowPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      differences.push(`the file lacks the ${name} table`);
    }
  }
  return differences;
}

/**
 * How long a statement refused with `SQLITE_BUSY` is retried before the
 * refusal stands: longer than any write transaction the server opens or
 * any checkpoint a sidecar takes on the file, short enough that a lock a
 * stuck process holds surfaces as an error rather than a hang.
 */
const BUSY_BUDGET_MS = 5_000;
/**
 * The budget this process actually uses, which an instance may set.
 *
 * A module constant could not be provoked: a fixture that wants to see
 * the refusal would have to win a race against a five-second retry loop,
 * and a test that races is a test that passes for the wrong reason.
 * Booted at zero, the first `SQLITE_BUSY` is the answer, so the refusal
 * is asserted rather than hoped for.
 */
let busyBudgetMs = BUSY_BUDGET_MS;

export function setBusyBudgetMs(ms: number | undefined): void {
  // `undefined` leaves the default standing rather than overwriting it
  // with a second copy of the same number, so `BUSY_BUDGET_MS` above is
  // the only place the value is written down.
  if (ms !== undefined) busyBudgetMs = ms;
}
/** The first wait between tries, doubled up to the cap: a lock held for a
 *  millisecond costs a millisecond, and one held for seconds is not asked
 *  about a thousand times. */
const BUSY_RETRY_MIN_MS = 1;
const BUSY_RETRY_MAX_MS = 50;

/**
 * Whether this refusal is the write lock, wherever in the chain it is.
 *
 * **The chain, because most of these arrive wrapped.** Drizzle catches
 * what the driver threw and re-throws an error of its own — `Failed
 * query: update "api_keys" set ...` — carrying the original as `cause`
 * and no `code` of its own. Reading the top level alone would therefore
 * see the lock only on the statements that go through the raw client,
 * and every write that goes through Drizzle is most of them.
 */
function isBusy(err: unknown): boolean {
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step === null || typeof step !== "object") return false;
    const code = (step as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
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
function contention(budgetMs: number): MarfaError {
  return new MarfaError(
    ErrorCode.WRITE_CONTENTION,
    "The row is being written by something else and the lock did not free in time. Nothing was written; retry.",
    { budget_ms: budgetMs },
  );
}

export async function untilNotBusy<T>(
  attempt: () => Promise<T>,
  budgetMs = busyBudgetMs,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let wait = BUSY_RETRY_MIN_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!isBusy(err)) throw err;
      if (remaining <= 0) {
        // The budget is spent and the lock is still held. Rethrowing
        // the driver's own error hands the handler something with no
        // code, which becomes a `500` — the instance reporting itself
        // broken about the one failure that clears itself on its own.
        // A device reads a `5xx` as retryable and a `500` as a fault, so
        // the status would be right by accident while the code said the
        // wrong thing.
        throw contention(budgetMs);
      }
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
function waitingForTheLock(url: string): Client {
  const client = createClient({ url });
  const transactions = transactionConnections(url);
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
    transaction: (mode: TransactionMode = "write") =>
      untilNotBusy(() => transactions.begin(mode)),
    executeMultiple: (sql) =>
      untilNotBusy(() => one(() => client.executeMultiple(sql))),
    sync: () => client.sync(),
    close: () => {
      client.close();
      transactions.close();
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

const BEGIN: Record<TransactionMode, string> = {
  write: "BEGIN IMMEDIATE",
  read: "BEGIN TRANSACTION READONLY",
  deferred: "BEGIN DEFERRED",
};

/**
 * The connections transactions run on, each handed to the next transaction
 * once its own has ended.
 *
 * libsql's own `transaction()` gives the transaction the client's
 * connection, opens a fresh one for the client, and never closes the one
 * it gave away. Closing it would not be enough: a connection stays open
 * after `close()` for as long as a prepared statement refers to it, and
 * every statement the driver runs is a prepared one, so only the collector
 * ever let it go. Each transaction held the database and its log open, two
 * descriptors apiece, until a collection happened to run. A connection that
 * outlives its transaction and serves the next costs nothing per
 * transaction.
 *
 * Only a transaction that ended with its own `COMMIT` or `ROLLBACK`, or
 * that SQLite ended itself, hands its connection on. One whose `BEGIN`,
 * `COMMIT` or `ROLLBACK` failed, or whose statement was refused the lock,
 * is closed instead, for the reason `waitingForTheLock` gives for dropping
 * a refused connection, and that connection too stays open until a
 * collection, since its refused statement still refers to it.
 *
 * So a write transaction waits here for the one before it in this process
 * to end, rather than meeting its lock in `BEGIN IMMEDIATE`: every refusal
 * the retry absorbed cost a connection, up to a hundred of them for one
 * wait. The wait is held to the same budget as the retry and ends in the
 * same refusal. A lock another process holds still meets the retry, and
 * still costs a connection per refusal, because no client call resets the
 * refused statement.
 */
function transactionConnections(url: string): {
  begin: (mode: TransactionMode) => Promise<Transaction>;
  close: () => void;
} {
  const idle: Client[] = [];
  let shut = false;
  let lastWriter: Promise<void> = Promise.resolve();
  const awaitTurn = async (turn: Promise<void>): Promise<void> => {
    const budgetMs = busyBudgetMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(contention(budgetMs));
          }, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const handBack = (conn: Client, sound: boolean) => {
    if (sound && !shut && !conn.closed) idle.push(conn);
    else conn.close();
  };

  const refuseOnceShut = () => {
    if (shut) throw new LibsqlError("The client is closed", "CLIENT_CLOSED");
  };

  const begin = async (mode: TransactionMode): Promise<Transaction> => {
    refuseOnceShut();
    let leave: () => void = () => undefined;
    if (mode === "write") {
      const turn = lastWriter;
      lastWriter = new Promise((resolve) => {
        // A transaction that gave up waiting still holds its place until
        // the one ahead of it ends, so the next never overtakes that one.
        leave = () => {
          void turn.then(() => {
            resolve();
          });
        };
      });
      try {
        await awaitTurn(turn);
        refuseOnceShut();
      } catch (err) {
        leave();
        throw err;
      }
    }
    const conn = idle.pop() ?? createClient({ url });
    try {
      await conn.execute(BEGIN[mode]);
    } catch (err) {
      handBack(conn, false);
      leave();
      throw err;
    }
    let open = true;
    const closedError = () =>
      new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED");
    const finish = (sound: boolean) => {
      open = false;
      handBack(conn, sound);
      leave();
    };
    const end = async (sql: "COMMIT" | "ROLLBACK") => {
      open = false;
      try {
        await conn.execute(sql);
      } catch (err) {
        finish(false);
        throw err;
      }
      finish(true);
    };
    // A failed statement may have ended the transaction on SQLite's side
    // (a full disk, an I/O error), and the next statement would then run
    // outside it and commit on its own. A `BEGIN` succeeds only outside a
    // transaction, so it answers whether this one is still open.
    const stillOpen = async (): Promise<boolean> => {
      try {
        await conn.execute("BEGIN DEFERRED");
      } catch {
        return true;
      }
      await conn.execute("ROLLBACK").catch(() => {
        conn.close();
      });
      return false;
    };
    const execute = async (
      stmtOrSql: InStatement | string,
      args?: InArgs,
    ): Promise<ResultSet> => {
      if (!open) throw closedError();
      try {
        return typeof stmtOrSql === "string"
          ? await conn.execute(stmtOrSql, args)
          : await conn.execute(stmtOrSql);
      } catch (err) {
        if (isBusy(err)) finish(false);
        else if (!(await stillOpen())) finish(true);
        throw err;
      }
    };

    return {
      get closed() {
        return !open;
      },
      execute,
      batch: async (stmts) => {
        const results: ResultSet[] = [];
        for (const stmt of stmts) results.push(await execute(stmt));
        return results;
      },
      // The client's `executeMultiple` rolls back whatever transaction its
      // connection is in once it returns, which here is this one.
      executeMultiple: () =>
        Promise.reject(
          new LibsqlError(
            "A transaction here runs one statement at a time",
            "TRANSACTION_CLOSED",
          ),
        ),
      commit: async () => {
        if (!open) throw closedError();
        await end("COMMIT");
      },
      rollback: async () => {
        if (open) await end("ROLLBACK");
      },
      close: () => {
        if (open) void end("ROLLBACK").catch(() => undefined);
      },
    };
  };

  return {
    begin,
    close: () => {
      shut = true;
      for (const conn of idle.splice(0)) conn.close();
    },
  };
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
  const client = waitingForTheLock(toLibsqlUrl(sqlitePath));

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

  // A schema that is not this build's is refused for the same reason, and
  // here rather than at the DDL below: an index over a missing column fails
  // there with a driver error naming the index, after the PRAGMAs have
  // rewritten the header, and anything nothing indexes fails nowhere until
  // a request meets it.
  const differences = await schemaDifferences(client);
  if (differences.length > 0) {
    client.close();
    throw new Error(
      `The schema in ${sqlitePath} is not this build's: ${differences.join("; ")}. ` +
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
  const settings = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
  );
  if (settings.rows.length > 0) {
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
