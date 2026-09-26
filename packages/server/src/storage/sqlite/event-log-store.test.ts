/**
 * The retention sweep retires a prefix of the log. A row's stamp is taken
 * before its insert waits for the write lock, so a later id can carry an
 * earlier stamp; a sweep by stamp alone would then retire a row from the
 * middle of the log, above the oldest retained id, where the stream's
 * too-old check cannot see the hole.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

const HOUR = 3_600_000;

let tmpDir: string | undefined;
let storage: Storage | undefined;

afterEach(async () => {
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

  it("keeps the newest row when every row is older than the retention", async () => {
    // An empty log has no oldest id, so the stream could not tell a cursor
    // behind the retired rows that it missed them.
    const s = await logAged([3 * HOUR, 2 * HOUR]);
    expect(await s.eventLog.cleanup(1)).toBe(1);
    expect(await retainedIds(s)).toEqual([2n]);
  });
});
