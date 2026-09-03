import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPgStorage } from "../storage/pg/index.js";
import {
  withConnectionLifecycleLock,
  withConnectionLifecycleLockInTransaction,
} from "./lifecycle-lock.js";

/**
 * The Connection lifecycle lock against a pool smaller than the number of
 * callers waiting on it.
 *
 * Postgres-only: the lock is an advisory lock, and SQLite's coordination
 * store queues in process instead.
 *
 * These exist because a lock that takes a pool connection for the length
 * of its callback, from the pool that callback then queries, leaves
 * concurrent callers each holding one slot while waiting for a slot nobody
 * can release. postgres.js queues an unavailable connection with no bound,
 * so the result is a permanent stall rather than a slow patch.
 *
 * Both shapes reached it, a year apart and for different reasons. The
 * mints reached it by running on every dispatch of every integration,
 * and were moved onto the caller's own transaction. The bracketing shape
 * reached it because a Connection uninstall on a request that carries no
 * ambient transaction queries the pool for every step of its pipeline:
 * three concurrent uninstalls against a three-connection pool took every
 * slot and the server stopped answering. It now holds its lock on a pool
 * of its own.
 *
 * Every case below hangs rather than fails when its shape regresses, so
 * each carries an explicit timeout: an assertion that never runs reports
 * nothing useful. What arrives instead is the runner's own timeout naming
 * the case, which is why the names say what was being waited on.
 */
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

const POOL = 3;
const CALLERS = 8;

describe.skipIf(!isPg || !url)("connection lifecycle lock, pool bounds", () => {
  it("completes more concurrent holders than the pool has slots, on one Connection", async () => {
    const storage = await createPgStorage(url, { maxPoolSize: POOL });
    try {
      let inFlight = 0;
      let concurrentPeak = 0;

      const results = await Promise.all(
        Array.from({ length: CALLERS }, (_, i) =>
          withConnectionLifecycleLockInTransaction(
            storage,
            "pool-bounds-single",
            async () => {
              inFlight += 1;
              concurrentPeak = Math.max(concurrentPeak, inFlight);
              // Real work inside the lock: the deadlock needed the
              // callback to want the pool, which is what every mint does.
              await storage.keys.count();
              inFlight -= 1;
              return i;
            },
          ),
        ),
      );

      expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      // The lock still excludes: mints for one Connection revoke each
      // other's siblings, so overlapping them hands both callers a
      // credential the bearer gate refuses.
      expect(concurrentPeak).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("completes concurrent holders on distinct Connections", async () => {
    // The case the first diagnosis missed. Distinct keys never contend
    // for the lock, so nothing here is waiting on anything — and the
    // bracketing shape still deadlocked, because the slot was taken
    // before the key was ever compared.
    const storage = await createPgStorage(url, { maxPoolSize: POOL });
    try {
      const results = await Promise.all(
        Array.from({ length: CALLERS }, (_, i) =>
          withConnectionLifecycleLockInTransaction(
            storage,
            `pool-bounds-distinct-${String(i)}`,
            async () => {
              await storage.keys.count();
              return i;
            },
          ),
        ),
      );

      expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("completes more concurrent bracketing holders than the pool has slots, on one Connection", async () => {
    const storage = await createPgStorage(url, { maxPoolSize: POOL });
    try {
      let inFlight = 0;
      let concurrentPeak = 0;

      const results = await Promise.all(
        Array.from({ length: CALLERS }, (_, i) =>
          withConnectionLifecycleLock(
            storage,
            "pool-bounds-bracketing-single",
            async () => {
              inFlight += 1;
              concurrentPeak = Math.max(concurrentPeak, inFlight);
              // The callback wants the pool, which is what every lifecycle
              // pipeline does: an uninstall reads the Connection, revokes
              // credentials, deletes tokens and writes an audit row, each
              // on a connection this lock must not be holding.
              await storage.keys.count();
              inFlight -= 1;
              return i;
            },
          ),
        ),
      );

      expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      // Still one at a time. Removing the pool ceiling must not remove the
      // exclusion, which is the whole reason the lock is here.
      expect(concurrentPeak).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("completes concurrent bracketing holders on distinct Connections", async () => {
    // The case that says this is a pool defect rather than a locking one.
    // Distinct keys never contend, so nothing here waits on anything, and
    // the bracketing shape wedged anyway because the slot is taken before
    // the key is ever compared. It is also the shape the outage had:
    // three backends holding three different lifecycle locks, each idle in
    // transaction, each waiting on a pool the other two had emptied.
    const storage = await createPgStorage(url, { maxPoolSize: POOL });
    try {
      const results = await Promise.all(
        Array.from({ length: CALLERS }, (_, i) =>
          withConnectionLifecycleLock(
            storage,
            `pool-bounds-bracketing-distinct-${String(i)}`,
            async () => {
              await storage.keys.count();
              return i;
            },
          ),
        ),
      );

      expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("excludes a bracketing holder and a transaction-riding one from each other", async () => {
    // The two shapes coexist: uninstall and pause keep the bracketing
    // form because they run multi-step pipelines while holding the lock,
    // and a transaction held open across the whole pipeline is the
    // worse trade. They must still exclude each other, which they do by
    // taking the same advisory key.
    const storage = await createPgStorage(url, { maxPoolSize: POOL });
    try {
      let inFlight = 0;
      let concurrentPeak = 0;
      const work = async (): Promise<void> => {
        inFlight += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        inFlight -= 1;
      };

      await Promise.all([
        withConnectionLifecycleLock(storage, "pool-bounds-mixed", work),
        withConnectionLifecycleLockInTransaction(
          storage,
          "pool-bounds-mixed",
          work,
        ),
      ]);

      expect(concurrentPeak).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);
});

/**
 * The cases above prove the primitive. This one guards the callers, and
 * needs no database: the outage was not a broken lock but the wrong lock
 * on a hot path, and that is a property of which helper a file imports.
 * Same shape as the advisory-lock scope guard in `storage/pg`.
 */
describe("credential mints stay on the transaction-riding lock", () => {
  const mintPaths = ["../integrations/local-runtime/credentials.ts"];

  it.each(mintPaths)("%s does not bracket the lock", async (relative) => {
    const source = await readFile(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf-8",
    );

    // The bracketing helper takes a pool connection of its own, and a
    // mint needs the pool again inside it. On a path that runs per
    // dispatch that is what emptied the pool. Matching on the call
    // rather than the import because the import is the easy half to
    // notice in review.
    expect(source).not.toMatch(/\bwithConnectionLifecycleLock\s*\(/);
    expect(source).toMatch(/\bwithConnectionLifecycleLockInTransaction\s*\(/);
  });
});
