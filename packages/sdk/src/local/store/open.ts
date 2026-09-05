import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localFilePathFor } from "./paths.js";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { localSchema } from "./schema.js";
import { resolveLocalMigrationsFolder } from "./migrations-folder.js";
import { codeSchemaStamp, storeSchemaStamp } from "./version.js";

export type LocalDb = ReturnType<typeof drizzle<typeof localSchema>>;

/**
 * Translate a filesystem path into the URL shape libsql expects.
 *
 * `:memory:` maps to the shared-cache form because an interactive write
 * transaction opens a second logical connection, and a plain in-memory
 * database gives that connection its own empty copy. The consequence is
 * that every `:memory:` store in one process is the *same* database, so
 * tests that need isolation use a temporary file — which is also the shape
 * the engine actually ships in.
 */
export function toLibsqlUrl(pathOrUrl: string): string {
  if (pathOrUrl === ":memory:") return "file::memory:?cache=shared";
  if (
    pathOrUrl.startsWith("file:") ||
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("libsql://")
  ) {
    return pathOrUrl;
  }
  return `file:${pathOrUrl}`;
}

export interface OpenDbResult {
  db: LocalDb;
  raw: Client;
  close: () => void;
}

/**
 * Open the database and migrate it, without deciding what a failure means.
 *
 * Split from {@link openDatabase} so the caller can look at a store it
 * cannot migrate before anything is done about it. The two questions have
 * different answers: this one is "does it open", and the caller's is "may
 * this store be set aside", which needs the queue read out of it first.
 */
export interface InspectedDb extends OpenDbResult {
  /** Whether the store carries a schema this build does not ship. A store
   *  written by a newer engine has migrations this code has never seen,
   *  and running forward against it is not something migrations can undo. */
  newerThanCode: boolean;
  /** The migration failure, when one is why this is being reported. */
  migrationError?: unknown;
}

/**
 * Open a store far enough to judge it.
 *
 * Never throws for a schema reason: a store that cannot be migrated comes
 * back with the failure attached and its client still open, because the
 * caller has to read the outbox out of it before anything else happens.
 */
export async function inspectDatabase(path: string): Promise<InspectedDb> {
  const opened = await openConnection(path);
  const folder = resolveLocalMigrationsFolder(import.meta.url);

  const stamp = await storeSchemaStamp(opened.raw);
  const newerThanCode = stamp !== undefined && stamp > codeSchemaStamp(folder);
  if (newerThanCode) return { ...opened, newerThanCode };

  try {
    await migrate(opened.db, { migrationsFolder: folder });
  } catch (migrationError) {
    return { ...opened, newerThanCode: false, migrationError };
  }

  return { ...opened, newerThanCode: false };
}

/** Open the store's database, run its migrations forward, and hand back
 *  both the drizzle handle and the raw client. */
export async function openDatabase(path: string): Promise<OpenDbResult> {
  const opened = await openConnection(path);
  await migrate(opened.db, {
    migrationsFolder: resolveLocalMigrationsFolder(import.meta.url),
  });
  return opened;
}

/** Open the connection and set the pragmas, with no opinion on schema. */
async function openConnection(path: string): Promise<OpenDbResult> {
  const file = localFilePathFor(path);
  if (file !== undefined) {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const raw = createClient({ url: toLibsqlUrl(path) });
  // libsql opens a file-backed database in `delete`, so this is a request
  // rather than a restatement of the default. The engine reads the store on
  // the interactive path while the drain writes to it, and in `delete` mode
  // a writer locks every reader out for the length of its transaction.
  await raw.execute("PRAGMA journal_mode = WAL");
  await raw.execute("PRAGMA foreign_keys = ON");
  // A plain statement on this connection can meet the write lock held by
  // an interactive transaction, which libsql runs on a connection of its
  // own, and WAL admits one writer. Without a timeout the statement is
  // refused outright rather than waiting for a lock it would get in
  // microseconds.
  //
  // It cannot help the other direction — a `BEGIN` refused because this
  // connection is mid-transaction — because the timeout is a property of
  // the connection being refused, and that one is libsql's rather than
  // ours. Serializing transactions per store handle is what covers that,
  // and the two together are what "one writer per store" means inside a
  // process.
  //
  // Five seconds is a ceiling on a legitimate write rather than a guess:
  // the longest lock this engine takes is one transaction — a hydration
  // page, or the drain settling one response — which is milliseconds.
  // Reaching this is a writer that has stopped rather than a busy one.
  await raw.execute("PRAGMA busy_timeout = 5000");

  const db = drizzle(raw, { schema: localSchema });

  return {
    db,
    raw,
    close: () => {
      raw.close();
    },
  };
}
