import { stat } from "node:fs/promises";
import * as clock from "./clock.js";
import type { Storage } from "./storage/interface.js";
import { fileSystemPath } from "./storage/sqlite/connection.js";

/**
 * The server's own size and cost, as `GET /metrics` shows it and as the daily
 * report sends it.
 *
 * Counting a table of a million rows takes the SQLite driver several
 * milliseconds to tens of them, during which it answers nothing else. So a
 * request never counts: it reads the last count and, when there is none or it
 * is over an hour old, starts one refresh in the background. Nothing counts
 * when nobody asks. The daily report counts fresh before it sends.
 */

/** How long a count stays current. */
export const COUNT_STALE_AFTER_MS = 60 * 60 * 1000;

const BYTES_PER_KIB = 1024;

/** A figure the process could not read is `null`, and the others still stand. */
export interface ProcessFigures {
  release: string;
  rss_bytes: number | null;
  rss_peak_bytes: number | null;
  heap_used_bytes: number | null;
  heap_total_bytes: number | null;
  /** CPU seconds since the process started. */
  cpu_user_seconds: number | null;
  cpu_system_seconds: number | null;
  uptime_seconds: number;
}

export interface FileSizes {
  database_bytes: number | null;
  wal_bytes: number | null;
}

/** Rows of the tables that grow without bound, taken at `counted_at`. */
export interface TableCounts {
  items: number | null;
  versions: number | null;
  event_log: number | null;
  audit_log: number | null;
  counted_at: string;
}

/** Everything the daily report sends, read fresh. */
export interface ReportFigures {
  process: ProcessFigures;
  files: FileSizes;
  counts: TableCounts;
  blobs: { count: number; total_bytes: number } | null;
}

function safe(read: () => number): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readProcessFigures(release: string): ProcessFigures {
  return {
    release,
    rss_bytes: safe(() => process.memoryUsage().rss),
    rss_peak_bytes: safe(() => process.resourceUsage().maxRSS * BYTES_PER_KIB),
    heap_used_bytes: safe(() => process.memoryUsage().heapUsed),
    heap_total_bytes: safe(() => process.memoryUsage().heapTotal),
    cpu_user_seconds: safe(() => process.cpuUsage().user / 1_000_000),
    cpu_system_seconds: safe(() => process.cpuUsage().system / 1_000_000),
    uptime_seconds: Math.floor(process.uptime()),
  };
}

async function readNumber(read: () => Promise<number>): Promise<number | null> {
  try {
    const value = await read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function fileBytes(path: string, absent: number | null) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? absent : null;
  }
}

export interface FiguresKeeper {
  /** The last count, or `undefined` before the first. */
  last(): TableCounts | undefined;
  /**
   * Start one count in the background when there is none or the last is over
   * an hour old. Returns at once; one runs at a time.
   */
  refreshInBackground(): void;
  /** Count now, whoever asks; callers during a count share it. */
  count(): Promise<TableCounts>;
  /** The file sizes, which a stat reads without touching the database. */
  files(): Promise<FileSizes>;
  /** Process, files, a fresh count and the blob totals, for the report. */
  reportFigures(): Promise<ReportFigures>;
}

const keepers = new WeakMap<Storage, FiguresKeeper>();

/** The one keeper of a storage, so the route and the daily report share counts. */
export function figuresFor(
  storage: Storage,
  sqlitePath: string,
  release: string,
): FiguresKeeper {
  let keeper = keepers.get(storage);
  if (!keeper) {
    keeper = createFiguresKeeper(storage, sqlitePath, release);
    keepers.set(storage, keeper);
  }
  return keeper;
}

function createFiguresKeeper(
  storage: Storage,
  sqlitePath: string,
  release: string,
): FiguresKeeper {
  const databasePath =
    sqlitePath === ":memory:" ? undefined : fileSystemPath(sqlitePath);
  let latest: { counts: TableCounts; at: number } | undefined;
  let counting: Promise<TableCounts> | undefined;

  // One table to a statement, so other work runs between them.
  async function countTables(): Promise<TableCounts> {
    const items = await readNumber(async () =>
      Object.values(await storage.items.stats({ all_states: true })).reduce(
        (a, b) => a + b,
        0,
      ),
    );
    const versions = await readNumber(() => storage.versions.count());
    const eventLog = await readNumber(() => storage.eventLog.count());
    const auditLog = await readNumber(() => storage.audit.count());
    return {
      items,
      versions,
      event_log: eventLog,
      audit_log: auditLog,
      counted_at: clock.now().toISOString(),
    };
  }

  function count(): Promise<TableCounts> {
    counting ??= countTables()
      .then((counts) => {
        latest = { counts, at: clock.monotonicMs() };
        return counts;
      })
      .finally(() => {
        counting = undefined;
      });
    return counting;
  }

  async function files(): Promise<FileSizes> {
    if (!databasePath) return { database_bytes: null, wal_bytes: null };
    return {
      database_bytes: await fileBytes(databasePath, null),
      // A checkpoint can remove the log file; no file is no log.
      wal_bytes: await fileBytes(`${databasePath}-wal`, 0),
    };
  }

  return {
    last: () => latest?.counts,
    refreshInBackground() {
      if (latest && clock.monotonicMs() - latest.at < COUNT_STALE_AFTER_MS) {
        return;
      }
      void count();
    },
    count,
    files,
    async reportFigures() {
      const counts = await count();
      const blobs = await storage.blobs.count().then(
        (row) => ({ count: row.count, total_bytes: row.total_size_bytes }),
        () => null,
      );
      return {
        process: readProcessFigures(release),
        files: await files(),
        counts,
        blobs,
      };
    },
  };
}
