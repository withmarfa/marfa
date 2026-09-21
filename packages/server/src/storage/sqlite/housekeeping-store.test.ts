/**
 * The housekeeping table's own rules, each asserted from both sides: what
 * the row does under the condition, and what it does without it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { HousekeepingStore, Storage } from "../interface.js";

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let tmpDir: string | undefined;
let storage: Storage | undefined;

async function store(): Promise<HousekeepingStore> {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-housekeeping-"));
  storage = await createSqliteStorage(join(tmpDir, "marfa.db"));
  return storage.housekeeping;
}

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("SqliteHousekeepingStore", () => {
  it("keeps the earlier of an existing next_run_at and the boot's, and takes the new interval", async () => {
    const hk = await store();
    // A wake that arrived before a restart is earlier than the schedule the
    // boot computes, and survives it.
    await hk.upsert("woken", 60_000, at(60_000));
    expect(await hk.wake("woken", at(5))).toBe(true);
    await hk.upsert("woken", 30_000, at(30_000));
    expect(await hk.get("woken")).toMatchObject({
      next_run_at: at(5),
      interval_ms: 30_000,
    });
    // The witness: a boot that computes an earlier time than the row holds
    // pulls the row in.
    await hk.upsert("pulled", 60_000, at(60_000));
    await hk.upsert("pulled", 60_000, at(10_000));
    expect((await hk.get("pulled"))?.next_run_at).toBe(at(10_000));
  });

  it("lists and claims only what is due, and claims each name once", async () => {
    const hk = await store();
    await hk.upsert("later", 60_000, at(60_000));
    await hk.upsert("now", 60_000, at(0));
    expect(await hk.listDue(at(0))).toEqual(["now"]);
    expect(await hk.claimDue("later", at(0))).toBeNull();
    expect((await hk.get("later"))?.running_since).toBeNull();
    // Due once the clock reaches it.
    expect(await hk.listDue(at(60_000))).toEqual(["now", "later"]);
    expect((await hk.claimDue("later", at(60_000)))?.name).toBe("later");
    // A second claim of a claimed name is refused, by both claims.
    expect(await hk.claimDue("later", at(60_000))).toBeNull();
    expect(await hk.claim("later", at(60_000))).toBeNull();
    expect(await hk.listDue(at(60_000))).toEqual(["now"]);
  });

  it("wakes a known name and ignores an unknown one", async () => {
    const hk = await store();
    await hk.upsert("sleeper", 60_000, at(60_000));
    const before = await hk.list();
    expect(await hk.wake("nothing-here", at(0))).toBe(false);
    expect(await hk.list()).toEqual(before);
    expect(await hk.wake("sleeper", at(0))).toBe(true);
    expect((await hk.get("sleeper"))?.next_run_at).toBe(at(0));
  });
});
