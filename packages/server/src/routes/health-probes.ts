import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { Storage } from "../storage/interface.js";

/**
 * What `/health` asks of the machine beyond reading a row: whether a write
 * commits, and how much room is left to write into.
 */
export interface HealthProbes {
  /** Commits one write to the database, and rejects if it does not. */
  write(): Promise<void>;
  /** The bytes available on the volume that holds the least, counting the
   *  volume the database is on and the one the disk store is on. */
  availableBytes(): Promise<number>;
}

/** Below this the next write is expected to fail, so the instance is down. */
export const DISK_DOWN_BELOW_BYTES = 1024 * 1024;

/** Below this the instance still writes, with little room left. */
export const DISK_DEGRADED_BELOW_BYTES = 64 * 1024 * 1024;

/**
 * How long a committed probe write answers for the callers that follow it.
 * `/health` takes no credential, so what a caller can make the server do
 * has to stay small: a write is a sync to the disk and a frame in the
 * replicated log.
 */
export const WRITE_PROBE_REUSE_MS = 10_000;

const WRITE_PROBE_KEY = "health_probe";

export function storageProbes(
  storage: Pick<Storage, "settings">,
  paths: { sqlitePath: string; blobPath: string },
  now: () => number = Date.now,
): HealthProbes {
  let inFlight: Promise<void> | undefined;
  let settledAt = Number.NEGATIVE_INFINITY;
  let refusal: Error | undefined;

  const commit = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (now() - settledAt < WRITE_PROBE_REUSE_MS) {
      return refusal ? Promise.reject(refusal) : Promise.resolve();
    }
    const attempt = storage.settings
      .set(WRITE_PROBE_KEY, new Date(now()).toISOString())
      .then(
        () => {
          refusal = undefined;
        },
        (error: unknown) => {
          refusal = error instanceof Error ? error : new Error(String(error));
          throw refusal;
        },
      )
      .finally(() => {
        settledAt = now();
        inFlight = undefined;
      });
    inFlight = attempt;
    return attempt;
  };

  return {
    write: commit,
    availableBytes: async () => {
      const volumes = [dirname(paths.sqlitePath), paths.blobPath];
      const free = await Promise.all(
        volumes.map(async (volume) => {
          const stats = await statfs(volume);
          return stats.bavail * stats.bsize;
        }),
      );
      return Math.min(...free);
    },
  };
}
