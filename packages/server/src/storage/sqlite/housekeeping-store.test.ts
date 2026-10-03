/**
 * The housekeeping table's own rules, each asserted from both sides: what
 * the row does under the condition, and what it does without it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("SqliteHousekeepingStore", () => {
  it("serves a run's report as the door declares it, or not at all", async () => {
    const hk = await store();
    // The column holds whatever the build that wrote it reported, and a row
    // outlives that build: the doors declare a flat object of scalars, so a
    // row holding anything else is served as no report rather than as a
    // shape no caller can read. All or nothing, because a report with half
    // its counts removed reads as a run that did less than it did.
    const report = async (value: unknown) => {
      await hk.upsert("probe", 60_000, at(0));
      await hk.claim("probe", at(0));
      await hk.finish("probe", {
        finishedAt: at(1),
        outcome: "ok",
        error: null,
        result: value as Record<string, number> | null,
        nextRunAt: at(60_000),
      });
      return (await hk.get("probe"))?.last_result;
    };

    expect(
      await report({ deleted: 12, ok: true, status: null, note: "x" }),
    ).toEqual({
      deleted: 12,
      ok: true,
      status: null,
      note: "x",
    });
    expect(await report({})).toEqual({});
    expect(await report(null)).toBeNull();
    // The witness for each refusal: the same write, with one value the
    // declaration does not describe.
    expect(await report({ deleted: { inner: 1 } })).toBeNull();
    expect(await report({ good: 1, bad: { deep: true } })).toBeNull();
    expect(await report({ deleted: [1, 2] })).toBeNull();
    expect(await report(42)).toBeNull();
    expect(await report([1, 2])).toBeNull();
    expect(await report("swept")).toBeNull();
  });

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

it.each(["claim", "claimDue"] as const)(
  "keeps a wake after %s despite an earlier idle snapshot",
  async (claim) => {
    const hk = await store();
    await hk.upsert("webhook-poll", 30000, at(0));
    const idle = await hk.get("webhook-poll");
    expect(idle?.running_since).toBeNull();
    expect(await hk[claim]("webhook-poll", at(0))).not.toBeNull();
    const staleRead = vi.spyOn(hk, "get").mockResolvedValueOnce(idle);
    expect(await hk.wake("webhook-poll", at(0))).toBe(true);
    staleRead.mockRestore();
    await hk.finish("webhook-poll", {
      finishedAt: at(10),
      outcome: "ok",
      error: null,
      result: { attempted: 50 },
      nextRunAt: at(30010),
    });
    expect((await hk.get("webhook-poll"))?.next_run_at).toBe(at(1));
    expect(await hk.listDue(at(10))).toEqual(["webhook-poll"]);
  },
);

it.each(["claim", "claimDue"] as const)(
  "consumes an idle wake in a subsequent %s",
  async (claim) => {
    const hk = await store();
    await hk.upsert("webhook-poll", 30000, at(30000));
    expect(await hk.wake("webhook-poll", at(0))).toBe(true);
    expect(await hk[claim]("webhook-poll", at(0))).not.toBeNull();
    await hk.finish("webhook-poll", {
      finishedAt: at(10),
      outcome: "ok",
      error: null,
      result: { attempted: 1 },
      nextRunAt: at(30010),
    });
    expect((await hk.get("webhook-poll"))?.next_run_at).toBe(at(30010));
    expect(await hk.listDue(at(10))).toEqual([]);
  },
);

it.each(["claim", "claimDue"] as const)(
  "preserves a live wake after %s in the same millisecond",
  async (claim) => {
    const hk = await store();
    await hk.upsert("webhook-poll", 30000, at(0));
    expect(await hk[claim]("webhook-poll", at(0))).not.toBeNull();
    expect(await hk.wake("webhook-poll", at(0))).toBe(true);
    await hk.finish("webhook-poll", {
      finishedAt: at(10),
      outcome: "ok",
      error: null,
      result: { attempted: 1 },
      nextRunAt: at(30010),
    });
    expect((await hk.get("webhook-poll"))?.next_run_at).toBe(at(1));
    expect(await hk.listDue(at(10))).toEqual(["webhook-poll"]);
  },
);
