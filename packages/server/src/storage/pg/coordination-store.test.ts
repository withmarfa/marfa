import { describe, expect, it } from "vitest";
import { createPgStorage } from "./index.js";

// Postgres-only — advisory locks are a pg feature. SQLite's coordination
// store is a pass-through by design (single-process per DB file).
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg CoordinationStore", () => {
  it("withJobLock serializes concurrent callers on the same name", async () => {
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
        a.coordination.withJobLock("test-serialize", work),
        b.coordination.withJobLock("test-serialize", work),
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

  it("withExclusiveLock serializes concurrent callers on the same name", async () => {
    // The blocking counterpart of the try-lock above, and the one the
    // Connection lifecycle depends on: a mint re-reads Connection state
    // inside it precisely because uninstall may already have changed the
    // answer. Both callers must run — neither is allowed to skip — and
    // they must not overlap.
    const a = await createPgStorage(url);
    const b = await createPgStorage(url);
    try {
      let concurrentPeak = 0;
      let inFlight = 0;
      let ran = 0;
      const work = async (): Promise<void> => {
        inFlight += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight -= 1;
        ran += 1;
      };

      await Promise.all([
        a.coordination.withExclusiveLock("test-exclusive", work),
        b.coordination.withExclusiveLock("test-exclusive", work),
      ]);

      expect(ran).toBe(2);
      expect(concurrentPeak).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("withExclusiveLock releases on resolve and on throw", async () => {
    // A lock that outlives its holder is worse than no lock: the next
    // caller blocks forever holding a pool slot. The throw case is the
    // one that matters, since a mint that fails its state check inside
    // the lock is an ordinary outcome rather than an exceptional one.
    const storage = await createPgStorage(url);
    try {
      expect(
        await storage.coordination.withExclusiveLock(
          "test-exclusive-cycle",
          () => Promise.resolve(1),
        ),
      ).toBe(1);

      await expect(
        storage.coordination.withExclusiveLock("test-exclusive-cycle", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(
        await storage.coordination.withExclusiveLock(
          "test-exclusive-cycle",
          () => Promise.resolve("after"),
        ),
      ).toBe("after");
    } finally {
      await storage.close();
    }
  });

  it("withExclusiveLock lets its callback open its own transactions", async () => {
    // The lock runs in a transaction of its own; `fn` must still be able
    // to write through the ordinary storage path, which opens its own.
    // Wrapping `fn` inside the lock's transaction instead would make the
    // two the same connection and turn every nested write into a
    // savepoint on a connection the caller does not know it is holding.
    const storage = await createPgStorage(url);
    try {
      const item = await storage.coordination.withExclusiveLock(
        "test-exclusive-nested-tx",
        () =>
          storage.runInTransaction(() =>
            storage.items.create({
              type: "core.note",
              properties: { body: "written under the lock" },
            }),
          ),
      );
      expect(await storage.items.get(item.id)).not.toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("withExclusiveLock: distinct lock names don't block each other", async () => {
    const a = await createPgStorage(url);
    const b = await createPgStorage(url);
    try {
      const [resA, resB] = await Promise.all([
        a.coordination.withExclusiveLock("test-excl-distinct-a", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "a";
        }),
        b.coordination.withExclusiveLock("test-excl-distinct-b", async () => {
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
