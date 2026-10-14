/**
 * The retention sweep retires a prefix of the log. A row's stamp is taken
 * before its insert waits for the write lock, so a later id can carry an
 * earlier stamp; a sweep by stamp alone would then retire a row from the
 * middle of the log, above the oldest retained id, where the stream's
 * too-old check cannot see the hole.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";
import { SqliteEventLogStore } from "./event-log-store.js";
import type { DrizzleDb } from "./connection.js";

const HOUR = 3_600_000;

let tmpDir: string | undefined;
let storage: Storage | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

/** A log whose rows carry the given ages, in id order from 1. */
async function logAged(agesMs: number[]): Promise<Storage> {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-event-log-"));
  storage = await createSqliteStorage(join(tmpDir, "marfa.db"));
  const run = (
    storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun;
  const now = Date.now();
  for (const [i, age] of agesMs.entries()) {
    await run(
      "INSERT INTO event_log (id, event_type, item_id, payload, enable_fanout, created_at) VALUES (?, 'item.created', ?, '{}', 1, ?)",
      [i + 1, `item-${String(i + 1)}`, new Date(now - age).toISOString()],
    );
  }
  return storage;
}

async function retainedIds(s: Storage): Promise<bigint[]> {
  return (await s.eventLog.getAfter(0n, 100)).map((row) => row.id);
}

describe("SqliteEventLogStore.cleanup", () => {
  it("retires the rows older than the retention when their stamps follow id order", async () => {
    const s = await logAged([3 * HOUR, 2 * HOUR, 0, 0]);
    expect(await s.eventLog.cleanup(1)).toBe(2);
    expect(await retainedIds(s)).toEqual([3n, 4n]);
  });

  it("retires nothing above a row still within retention, whatever that row's successors are stamped", async () => {
    const s = await logAged([3 * HOUR, 0, 3 * HOUR, 0]);
    expect(await s.eventLog.cleanup(1)).toBe(1);
    expect(await retainedIds(s)).toEqual([2n, 3n, 4n]);
    expect(await s.eventLog.getMinRetainedId()).toBe(2n);
  });

  it("keeps a row stamped exactly at the cutoff", async () => {
    // Only the clock is frozen, so the stamp and the cutoff are the same
    // instant; the store's own waits still run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
    const s = await logAged([3 * HOUR, 1 * HOUR, 3 * HOUR, 0]);
    expect(await s.eventLog.cleanup(1)).toBe(1);
    expect(await retainedIds(s)).toEqual([2n, 3n, 4n]);
  });

  it("holds back every row above one stamped ahead of the clock, until its stamp ages", async () => {
    // A clock that ran ahead and was put back leaves such a row. Retiring
    // around it would leave a hole above the oldest retained id, so the
    // rows behind it wait.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    const s = await logAged([3 * HOUR, -1 * HOUR, 3 * HOUR, 3 * HOUR, 0]);
    expect(await s.eventLog.cleanup(1)).toBe(1);
    expect(await retainedIds(s)).toEqual([2n, 3n, 4n, 5n]);

    vi.setSystemTime(new Date("2026-09-27T15:00:00.000Z"));
    expect(await s.eventLog.cleanup(1)).toBe(3);
    expect(await retainedIds(s)).toEqual([5n]);
  });

  it("retires past the same row once it is stamped behind the clock", async () => {
    // The witness for the case above: the rows it held back are retired
    // when nothing ahead of the clock stands in front of them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    const s = await logAged([3 * HOUR, 3 * HOUR, 3 * HOUR, 3 * HOUR, 0]);
    expect(await s.eventLog.cleanup(1)).toBe(4);
    expect(await retainedIds(s)).toEqual([5n]);
  });

  it("keeps the newest row when every row is older than the retention", async () => {
    // An empty log has no oldest id, so the stream could not tell a cursor
    // behind the retired rows that it missed them.
    const s = await logAged([3 * HOUR, 2 * HOUR]);
    expect(await s.eventLog.cleanup(1)).toBe(1);
    expect(await retainedIds(s)).toEqual([2n]);
  });
});

describe("SqliteEventLogStore.getAfter within a byte budget", () => {
  async function logSized(sizes: number[]): Promise<Storage> {
    tmpDir = mkdtempSync(join(tmpdir(), "marfa-event-log-"));
    storage = await createSqliteStorage(join(tmpDir, "marfa.db"));
    for (const [i, size] of sizes.entries()) {
      await storage.eventLog.append({
        event_type: "item.created",
        item_id: `item-${String(i + 1)}`,
        payload: JSON.stringify({ body: "x".repeat(size) }),
      });
    }
    return storage;
  }

  it("answers the rows that fit, and always the first", async () => {
    const s = await logSized([400, 400, 400, 5_000, 10]);
    const ids = async (after: bigint, budget: number) =>
      (await s.eventLog.getAfter(after, 100, { maxBytes: budget })).map(
        (row) => row.id,
      );
    expect(await ids(0n, 1_000)).toEqual([1n, 2n, 3n]);
    expect(await ids(3n, 1_000)).toEqual([4n]);
    expect(await ids(4n, 1_000)).toEqual([5n]);
    expect(await ids(0n, 1_000_000)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(
      (await s.eventLog.getAfter(0n, 2, { maxBytes: 1_000_000 })).length,
    ).toBe(2);
  });
});

describe("SqliteEventLogStore.getNonFanoutEnd", () => {
  it("verifies a 50,000-row no-fanout prefix with one payload-free query", async () => {
    const s = await logAged([]);
    const raw = s as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<50000)
       INSERT INTO event_log (event_type, payload, enable_fanout, created_at)
       SELECT 'created', 'not JSON', 0, ? FROM rows`,
      [new Date().toISOString()],
    );
    const db = s.betterAuthDb as DrizzleDb;
    const store = new SqliteEventLogStore(db);
    const query = vi.spyOn(db, "get");
    try {
      expect(await store.getNonFanoutEnd(0n, 50000n)).toBe(50000n);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });
  it("stops before every fan-out and respects its captured head", async () => {
    const s = await logAged([0, 0, 0, 0, 0, 0]);
    const raw = s as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE event_log SET enable_fanout=0 WHERE id IN (1,2,4,6)",
      [],
    );
    expect(await s.eventLog.getNonFanoutEnd(0n, 6n)).toBe(2n);
    expect(await s.eventLog.getNonFanoutEnd(2n, 6n)).toBe(2n);
    expect(await s.eventLog.getNonFanoutEnd(3n, 6n)).toBe(4n);
    expect(await s.eventLog.getNonFanoutEnd(5n, 6n)).toBe(6n);
    expect(await s.eventLog.getNonFanoutEnd(0n, 1n)).toBe(1n);
  });
  it("refuses an internal hole, a missing tail and an ahead cursor", async () => {
    const s = await logAged([0, 0, 0]);
    const raw = s as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun("UPDATE event_log SET enable_fanout=0", []);
    expect(await s.eventLog.getNonFanoutEnd(0n, 3n)).toBe(3n);
    await raw.__sqliteRun("DELETE FROM event_log WHERE id=2", []);
    await expect(s.eventLog.getNonFanoutEnd(0n, 3n)).rejects.toThrow(
      "inconsistent",
    );
    await expect(s.eventLog.getNonFanoutEnd(3n, 4n)).rejects.toThrow(
      "inconsistent",
    );
    await expect(s.eventLog.getNonFanoutEnd(4n, 3n)).rejects.toThrow("ahead");
  });
  it("keeps adjacent IDs exact beyond 2^53 and at the i64 ceiling", async () => {
    const s = await logAged([]);
    const raw = s as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    for (const start of [9007199254740992n, 9223372036854775804n]) {
      for (let n = 1n; n <= 3n; n++)
        await raw.__sqliteRun(
          "INSERT INTO event_log (id, event_type, payload, enable_fanout, created_at) VALUES (CAST(? AS INTEGER), 'created', '{}', ?, ?)",
          [(start + n).toString(), n === 3n ? 1 : 0, new Date().toISOString()],
        );
      expect(await s.eventLog.getNonFanoutEnd(start, start + 3n)).toBe(
        start + 2n,
      );
      expect(await s.eventLog.getNonFanoutEnd(start, start + 1n)).toBe(
        start + 1n,
      );
      expect(await s.eventLog.getNonFanoutEnd(start + 2n, start + 3n)).toBe(
        start + 2n,
      );
    }
  });
});
