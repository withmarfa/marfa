import { stat } from "node:fs/promises";
import * as clock from "./clock.js";
import type { Storage } from "./storage/interface.js";
import { fileSystemPath } from "./storage/sqlite/connection.js";

/**
 * The server's own size and cost, as `GET /metrics` shows it and as the daily
 * report sends it. One function builds both, so the two cannot drift.
 *
 * Counting a table of a million rows takes the SQLite driver several
 * milliseconds to tens of them, during which it answers nothing else. So the
 * counts are taken off the request path, one table to a statement so that
 * other work runs between them, and a reader gets the last count with the
 * time it was taken.
 */

/** How long a count stays current while the hourly refresh is not running. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const COUNT_REFRESH_MS = 60 * 60 * 1000;

const BYTES_PER_KIB = 1024;

export interface ProcessFigures {
  release: string;
  rss_bytes: number;
  rss_peak_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  /** CPU seconds since the process started. */
  cpu_user_seconds: number;
  cpu_system_seconds: number;
  uptime_seconds: number;
}

/** A figure that could not be read is `null`, and the others still stand. */
export interface StorageFigures {
  database_bytes: number | null;
  wal_bytes: number | null;
  items: number | null;
  versions: number | null;
  event_log: number | null;
  audit_log: number | null;
  blobs: number | null;
  blob_bytes: number | null;
  items_by_state: Record<string, number> | null;
  counted_at: string;
}

export interface InstanceFigures {
  process: ProcessFigures;
  storage: StorageFigures;
}

const startedAt = clock.monotonicMs();

export function readProcessFigures(release: string): ProcessFigures {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    release,
    rss_bytes: memory.rss,
    rss_peak_bytes: process.resourceUsage().maxRSS * BYTES_PER_KIB,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    cpu_user_seconds: cpu.user / 1_000_000,
    cpu_system_seconds: cpu.system / 1_000_000,
    uptime_seconds: Math.floor((clock.monotonicMs() - startedAt) / 1000),
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
  /** The last count, taken now when there is none or it has gone stale. */
  read(): Promise<InstanceFigures>;
  /** Count again, whoever asks; callers during a count share it. */
  refresh(): Promise<StorageFigures>;
  /** Refresh every hour, off every request, until {@link stop}. */
  start(): void;
  stop(): void;
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
  let latest: { figures: StorageFigures; at: number } | undefined;
  let counting: Promise<StorageFigures> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function count(): Promise<StorageFigures> {
    const itemsByState = await (async () => {
      try {
        return await storage.items.stats({ all_states: true });
      } catch {
        return null;
      }
    })();
    const versions = await readNumber(() => storage.versions.count());
    const eventLog = await readNumber(() => storage.eventLog.count());
    const auditLog = await readNumber(() => storage.audit.count());
    let blobs: number | null = null;
    let blobBytes: number | null = null;
    try {
      const row = await storage.blobs.count();
      blobs = row.count;
      blobBytes = row.total_size_bytes;
    } catch {
      /* The other figures still stand. */
    }
    const databaseBytes = databasePath
      ? await fileBytes(databasePath, null)
      : null;
    // A checkpoint can remove the log file; no file is no log.
    const walBytes = databasePath
      ? await fileBytes(`${databasePath}-wal`, 0)
      : null;
    return {
      database_bytes: databaseBytes,
      wal_bytes: walBytes,
      items: itemsByState
        ? Object.values(itemsByState).reduce((a, b) => a + b, 0)
        : null,
      versions,
      event_log: eventLog,
      audit_log: auditLog,
      blobs,
      blob_bytes: blobBytes,
      items_by_state: itemsByState,
      counted_at: clock.now().toISOString(),
    };
  }

  function refresh(): Promise<StorageFigures> {
    counting ??= count()
      .then((figures) => {
        latest = { figures, at: clock.monotonicMs() };
        return figures;
      })
      .finally(() => {
        counting = undefined;
      });
    return counting;
  }

  return {
    refresh,
    async read() {
      const fresh =
        latest && clock.monotonicMs() - latest.at < STALE_AFTER_MS
          ? latest.figures
          : await refresh();
      return { process: readProcessFigures(release), storage: fresh };
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void refresh().catch(() => undefined);
      }, COUNT_REFRESH_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
