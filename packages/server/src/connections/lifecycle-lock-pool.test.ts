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
 * These exist because the bracketing shape took a pool connection of its
 * own for the length of its callback, and the callback then needed the
 * same pool to do its work. Concurrent callers therefore each held one
 * slot while waiting for a slot nobody could release, and postgres.js
 * queues an unavailable reservation with no bound, so the result was a
 * permanent stall rather than a slow patch. Minting a runtime credential
 * ran through that shape on every dispatch of every integration, and
 * production stopped answering.
 *
 * Both cases below hang rather than fail when the mint path regresses to
 * the bracketing shape, so give them an explicit timeout: an assertion
 * that never runs reports nothing useful.
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

  it("excludes a bracketing holder and a transaction-riding one from each other", async () => {
    // The two shapes coexist: uninstall and pause keep the bracketing
    // form because they call the control plane while holding the lock,
    // and a transaction held open across a network round trip is the
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
