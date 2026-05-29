import { describe, expect, it } from "vitest";
import { createPgStorage } from "./index.js";

// Postgres-only — advisory locks are a pg feature. SQLite's coordination
// store is a pass-through by design (single-process per DB file).
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg CoordinationStore", () => {
  it("withJobLock serialises concurrent callers on the same name", async () => {
    // Two separate Storage instances against the same DB simulate two
    // server processes. Each has its own connection pool, so the advisory
    // lock is the only thing keeping them apart.
    const a = await createPgStorage(url);
    const b = await createPgStorage(url);
    try {
      let concurrentPeak = 0;
      let inFlight = 0;
      const work = async (): Promise<string> => {
        inFlight += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight -= 1;
        return "ran";
      };

      const [resA, resB] = await Promise.all([
        a.coordination.withJobLock("test-serialise", work),
        b.coordination.withJobLock("test-serialise", work),
      ]);

      // Exactly one caller got the lock; the other saw a contended lock and
      // returned undefined. Order is non-deterministic.
      const ran = [resA, resB].filter((r) => r === "ran");
      const skipped = [resA, resB].filter((r) => r === undefined);
      expect(ran.length).toBe(1);
      expect(skipped.length).toBe(1);
      expect(concurrentPeak).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("releases the lock after fn resolves so subsequent calls can claim", async () => {
    const storage = await createPgStorage(url);
    try {
      const first = await storage.coordination.withJobLock(
        "test-sequential",
        () => Promise.resolve(1),
      );
      const second = await storage.coordination.withJobLock(
        "test-sequential",
        () => Promise.resolve(2),
      );
      expect(first).toBe(1);
      expect(second).toBe(2);
    } finally {
      await storage.close();
    }
  });

  it("releases the lock after fn throws", async () => {
    const storage = await createPgStorage(url);
    try {
      await expect(
        storage.coordination.withJobLock("test-throws", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // Lock should be free now — a subsequent caller acquires.
      const result = await storage.coordination.withJobLock("test-throws", () =>
        Promise.resolve("after"),
      );
      expect(result).toBe("after");
    } finally {
      await storage.close();
    }
  });

  it("distinct lock names don't block each other", async () => {
    const a = await createPgStorage(url);
    const b = await createPgStorage(url);
    try {
      const [resA, resB] = await Promise.all([
        a.coordination.withJobLock("test-distinct-a", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "a";
        }),
        b.coordination.withJobLock("test-distinct-b", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "b";
        }),
      ]);
      expect(resA).toBe("a");
      expect(resB).toBe("b");
    } finally {
      await a.close();
      await b.close();
    }
  });
});
