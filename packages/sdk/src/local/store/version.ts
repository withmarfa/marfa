import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

/**
 * Whether this code can open what is on disk, and what to do when it
 * cannot.
 *
 * A store carries a version because migrations only run one way. Code that
 * has been rolled back, or a build older than the one that last wrote,
 * meets a schema with columns it does not know and constraints it cannot
 * satisfy — and drizzle's migrator has nothing to say about that, because
 * it only ever looks for work still to do.
 */

interface JournalEntry {
  when: number;
}

/**
 * The newest migration the store has applied, or undefined when it has
 * applied none.
 *
 * Read straight from the migrator's own table rather than from anything
 * this engine keeps beside it, so the two cannot disagree about what has
 * run.
 */
export async function storeSchemaStamp(
  raw: Client,
): Promise<number | undefined> {
  try {
    const result = await raw.execute(
      "SELECT MAX(created_at) AS newest FROM __drizzle_migrations",
    );
    const row = result.rows[0] as unknown as { newest: unknown } | undefined;
    const newest = row?.newest;
    if (newest === null || newest === undefined) return undefined;
    return Number(newest);
  } catch {
    // No table means nothing has ever been migrated here, which is a
    // fresh store rather than a broken one.
    return undefined;
  }
}

/** The newest migration this build ships. */
export function codeSchemaStamp(migrationsFolder: string): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries.reduce((newest, entry) => {
    return entry.when > newest ? entry.when : newest;
  }, 0);
}

/** Why a store had to be set aside. */
export type RecoveryReason = "store_is_newer" | "migration_failed";

/**
 * What was rescued before a store was set aside, and where it was put.
 *
 * Handed to the app rather than logged, because everything in it is work
 * a person did: unsent writes and refusals they had not read yet. An app
 * that is told can offer them back; one that is not cannot.
 */
export interface StoreRecovery {
  reason: RecoveryReason;
  /** Absolute path of the JSON the queue and the log were written to. */
  sidecarPath: string;
  /** Where the store that could not be opened was moved to. */
  supersededPath: string;
  /** Queued mutations rescued. */
  outbox: number;
  /** Dead letters rescued. */
  deadLetters: number;
  /** The failure, when a migration is what went wrong. */
  cause?: unknown;
}

/** A store this code cannot open and cannot safely set aside. */
export class StoreUnrecoverableError extends Error {
  readonly reason: RecoveryReason;
  constructor(reason: RecoveryReason, detail: string, cause?: unknown) {
    super(
      `@withmarfa/sdk/local: this store cannot be opened (${reason}) and cannot be set aside safely: ${detail}. ` +
        `Refusing rather than rebuilding — a rebuild here would discard unsent writes with nothing kept.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "StoreUnrecoverableError";
    this.reason = reason;
  }
}

/** Rows read straight out of a schema this code may not understand. */
async function rescueRows(
  raw: Client,
  table: string,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await raw.execute(`SELECT * FROM ${table}`);
    return result.rows;
  } catch {
    // The table is gone, renamed, or unreadable under whatever wrote this
    // store. Nothing to rescue is a fact worth recording rather than a
    // reason to stop: the sidecar still says what was found.
    return [];
  }
}

/**
 * Write the unsent work to a sidecar and move the store out of the way.
 *
 * The order is the whole guarantee, and it only runs one way: read, write
 * the sidecar, verify it is there, and only then move the store. Anything
 * that fails before the move leaves the store exactly as it was and
 * refuses, so the failure mode is a store that will not open rather than
 * one that opened empty.
 *
 * That direction is deliberate. An engine that always recovers, and
 * sometimes silently loses everything, is worse than one that recovers
 * when it can and otherwise says so — the first leaves a person with a
 * working app and no way to know what went missing, and only the second
 * is something a consumer can act on.
 */
export async function setStoreAside(options: {
  raw: Client;
  path: string;
  reason: RecoveryReason;
  now: () => string;
  cause?: unknown;
}): Promise<StoreRecovery> {
  const { raw, path, reason, now, cause } = options;

  if (path === ":memory:" || /^(https?|libsql):/.test(path)) {
    throw new StoreUnrecoverableError(
      reason,
      `the store at ${path} is not a file this engine can move aside`,
      cause,
    );
  }

  const file = path.startsWith("file:") ? path.slice(5) : path;
  const stamp = now().replace(/[:.]/g, "-");
  const sidecarPath = `${file}.recovery-${stamp}.json`;
  const supersededPath = `${file}.superseded-${stamp}`;

  const outbox = await rescueRows(raw, "outbox");
  const deadLetters = await rescueRows(raw, "dead_letters");

  try {
    writeFileSync(
      sidecarPath,
      JSON.stringify(
        { reason, at: now(), store: file, outbox, deadLetters },
        null,
        2,
      ),
      // Refuses rather than overwriting: a sidecar already at this name
      // is another recovery's rescued work, and quietly replacing it
      // would destroy exactly what this exists to keep.
      { flag: "wx" },
    );
  } catch (error) {
    throw new StoreUnrecoverableError(
      reason,
      `could not write the recovery sidecar to ${sidecarPath}`,
      error,
    );
  }

  // The database is closed before the move, or the write-ahead log stays
  // attached to a file that is no longer where the client thinks it is.
  raw.close();

  try {
    renameSync(file, supersededPath);
    // The sidecar files travel with it. A fresh database opened beside a
    // stale write-ahead log replays that log into itself, which would
    // resurrect exactly the schema this is stepping away from.
    for (const suffix of ["-wal", "-shm"]) {
      try {
        renameSync(`${file}${suffix}`, `${supersededPath}${suffix}`);
      } catch {
        // Absent in a cleanly closed store, which is the ordinary case.
      }
    }
  } catch (error) {
    throw new StoreUnrecoverableError(
      reason,
      `could not move ${file} aside (the rescued work is safe at ${sidecarPath})`,
      error,
    );
  }

  return {
    reason,
    sidecarPath,
    supersededPath,
    outbox: outbox.length,
    deadLetters: deadLetters.length,
    ...(cause === undefined ? {} : { cause }),
  };
}
