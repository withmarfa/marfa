import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { Housekeeping } from "./scheduler.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

/** Shaped the way libsql raises them: an Error carrying a code. */
function dbError(code: string): Error {
  return Object.assign(new Error(`libsql ${code}`), { code });
}

interface CapturedLine {
  level: string;
  message: string;
}

/** Collects the JSON lines `log()` writes, which is its only observable. */
function captureLog(): { lines: CapturedLine[]; restore: () => void } {
  const lines: CapturedLine[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      lines.push(JSON.parse(String(chunk)) as CapturedLine);
      return true;
    });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** A clock the test moves by hand. */
function clock(start: number) {
  let now = start;
  return {
    nowFn: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

const T0 = Date.parse("2026-09-20T12:00:00.000Z");

/** A scheduler over the context's store that never polls on its own:
 *  the test calls `poll()` and `settle()` itself. */
function scheduler(nowFn: () => Date): Housekeeping {
  return new Housekeeping(ctx!.storage.housekeeping, {
    pollIntervalMs: 3_600_000,
    nowFn,
  });
}

async function names(): Promise<string[]> {
  return (await ctx!.storage.housekeeping.list()).map((row) => row.name);
}

describe("Housekeeping", () => {
  describe("register", () => {
    it("refuses a bad name, a duplicate, a non-positive interval, and a late registration", async () => {
      ctx = await createTestContext();
      const hk = scheduler(clock(T0).nowFn);
      const job = {
        intervalMs: 1_000,
        firstRunDelayMs: 0,
        run: () => Promise.resolve(1),
      };
      hk.register({ name: "fine", ...job });
      expect(() => {
        hk.register({ name: "Not Fine", ...job });
      }).toThrow(/not a job name/);
      expect(() => {
        hk.register({ name: "fine", ...job });
      }).toThrow(/twice/);
      expect(() => {
        hk.register({ name: "zero", ...job, intervalMs: 0 });
      }).toThrow(/positive interval/);
      await hk.start();
      expect(() => {
        hk.register({ name: "late", ...job });
      }).toThrow(/after start/);
      await hk.stop();
    });
  });

  describe("start", () => {
    it("writes a row per job due after its first-run delay, and removes rows nothing registers", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const first = scheduler(c.nowFn);
      first.register({
        name: "soon",
        intervalMs: 60_000,
        firstRunDelayMs: 5_000,
        run: () => Promise.resolve(null),
      });
      first.register({
        name: "later",
        intervalMs: 60_000,
        firstRunDelayMs: 30_000,
        run: () => Promise.resolve(null),
      });
      await first.start();
      await first.stop();
      const rows = await ctx.storage.housekeeping.list();
      expect(rows.map((row) => [row.name, row.next_run_at])).toEqual([
        ["later", new Date(T0 + 30_000).toISOString()],
        ["soon", new Date(T0 + 5_000).toISOString()],
      ]);
      expect(rows.every((row) => row.running_since === null)).toBe(true);

      // A second boot that no longer registers `later` removes its row.
      const second = scheduler(c.nowFn);
      second.register({
        name: "soon",
        intervalMs: 60_000,
        firstRunDelayMs: 5_000,
        run: () => Promise.resolve(null),
      });
      await second.start();
      await second.stop();
      expect(await names()).toEqual(["soon"]);
    });

    it("keeps a schedule across a restart, and pulls it in when the interval shrank", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const first = scheduler(c.nowFn);
      first.register({
        name: "daily",
        intervalMs: 86_400_000,
        firstRunDelayMs: 0,
        run: () => Promise.resolve({ did: "work" }),
      });
      await first.start();
      await first.poll();
      await first.settle();
      await first.stop();
      const ran = await ctx.storage.housekeeping.get("daily");
      expect(ran?.last_outcome).toBe("ok");
      expect(ran?.next_run_at).toBe(new Date(T0 + 86_400_000).toISOString());

      // Two hours later the process restarts: the job is due in twenty-two
      // hours, not now.
      c.advance(2 * 3_600_000);
      const second = scheduler(c.nowFn);
      second.register({
        name: "daily",
        intervalMs: 86_400_000,
        firstRunDelayMs: 0,
        run: () => Promise.resolve({ did: "work" }),
      });
      await second.start();
      await second.stop();
      expect((await ctx.storage.housekeeping.get("daily"))?.next_run_at).toBe(
        new Date(T0 + 86_400_000).toISOString(),
      );

      // Restarted with an hourly interval instead: an hour after the last
      // finish is already past, so the job is due now.
      const third = scheduler(c.nowFn);
      third.register({
        name: "daily",
        intervalMs: 3_600_000,
        firstRunDelayMs: 0,
        run: () => Promise.resolve({ did: "work" }),
      });
      await third.start();
      await third.stop();
      expect((await ctx.storage.housekeeping.get("daily"))?.next_run_at).toBe(
        new Date(T0 + 3_600_000).toISOString(),
      );
    });

    it("clears a run marker left by a process that died mid-run, and says so", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const store = ctx.storage.housekeeping;
      await store.upsert("stuck", 60_000, c.nowFn().toISOString());
      expect(
        await store.claim("stuck", c.nowFn().toISOString()),
      ).not.toBeNull();
      expect((await store.get("stuck"))?.running_since).not.toBeNull();

      const hk = scheduler(c.nowFn);
      let runs = 0;
      hk.register({
        name: "stuck",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () => {
          runs += 1;
          return Promise.resolve(null);
        },
      });
      const captured = captureLog();
      await hk.start();
      captured.restore();
      expect(captured.lines).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "Housekeeping runs left unfinished by an earlier process",
        }),
      );
      expect((await store.get("stuck"))?.running_since).toBeNull();
      // Due whenever its row said, which was before the crash: it runs once
      // on the first poll.
      await hk.poll();
      await hk.settle();
      await hk.stop();
      expect(runs).toBe(1);
    });
  });

  describe("poll", () => {
    it("runs what is due, records the result, and reschedules an interval after the finish", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      let runs = 0;
      hk.register({
        name: "counter",
        intervalMs: 60_000,
        firstRunDelayMs: 10_000,
        run: () => {
          runs += 1;
          c.advance(250);
          return Promise.resolve({ runs });
        },
      });
      await hk.start();
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(0);

      c.advance(10_000);
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(1);
      const row = await ctx.storage.housekeeping.get("counter");
      expect(row).toMatchObject({
        running_since: null,
        last_started_at: new Date(T0 + 10_000).toISOString(),
        last_finished_at: new Date(T0 + 10_250).toISOString(),
        last_outcome: "ok",
        last_error: null,
        last_result: { runs: 1 },
        next_run_at: new Date(T0 + 10_250 + 60_000).toISOString(),
      });

      // Not due again until the interval has passed since the finish.
      c.advance(59_000);
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(1);
      c.advance(1_000);
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(2);
      await hk.stop();
    });

    it("records a throw as the run's error and reschedules at the interval, never hotter", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      let runs = 0;
      hk.register({
        name: "faulty",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () => {
          runs += 1;
          return Promise.reject(new Error("the sweep broke"));
        },
      });
      await hk.start();
      const captured = captureLog();
      await hk.poll();
      await hk.settle();
      captured.restore();
      expect(runs).toBe(1);
      expect(captured.lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Housekeeping faulty error",
        }),
      );
      const row = await ctx.storage.housekeeping.get("faulty");
      expect(row).toMatchObject({
        running_since: null,
        last_outcome: "error",
        last_error: "the sweep broke",
        last_result: null,
        next_run_at: new Date(T0 + 60_000).toISOString(),
      });
      // The witness for "never hotter": a poll a moment later runs nothing.
      c.advance(1_000);
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(1);
      await hk.stop();
    });

    it("runs due jobs concurrently across names, and never overlaps one name with itself", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      let releaseSlow: () => void = () => undefined;
      const slowStarted = new Promise<void>((resolve) => {
        hk.register({
          name: "slow",
          intervalMs: 60_000,
          firstRunDelayMs: 0,
          run: () =>
            new Promise<null>((done) => {
              resolve();
              releaseSlow = () => {
                done(null);
              };
            }),
        });
      });
      let quickRuns = 0;
      hk.register({
        name: "quick",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () => {
          quickRuns += 1;
          return Promise.resolve(null);
        },
      });
      await hk.start();
      await hk.poll();
      await slowStarted;
      // `slow` is still running and `quick` did not wait behind it.
      await vi.waitFor(() => {
        expect(quickRuns).toBe(1);
      });
      expect((await ctx.storage.housekeeping.get("slow"))?.running_since).toBe(
        new Date(T0).toISOString(),
      );
      // A second poll while `slow` holds its row does not start it again,
      // and `runNow` is refused the same way.
      await hk.poll();
      expect(await hk.runNow("slow")).toEqual({ kind: "running" });
      releaseSlow();
      await hk.settle();
      expect((await ctx.storage.housekeeping.get("slow"))?.running_since).toBe(
        null,
      );
      await hk.stop();
    });

    it("honors a wake: the job is due now, and a wake during a run holds after it", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      let runs = 0;
      let releaseRun: () => void = () => undefined;
      let gate: Promise<void> | null = null;
      hk.register({
        name: "wakeable",
        intervalMs: 3_600_000,
        firstRunDelayMs: 3_600_000,
        run: async () => {
          runs += 1;
          if (gate) await gate;
          return null;
        },
      });
      await hk.start();
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(0);

      await hk.wake("wakeable");
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(1);
      expect(
        (await ctx.storage.housekeeping.get("wakeable"))?.next_run_at,
      ).toBe(new Date(T0 + 3_600_000).toISOString());

      // Woken while running: the wake is not lost to the finish's
      // rescheduling, so the next poll runs it again.
      gate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      c.advance(3_600_000);
      await hk.poll();
      await vi.waitFor(() => {
        expect(runs).toBe(2);
      });
      c.advance(1_000);
      await hk.wake("wakeable");
      releaseRun();
      await hk.settle();
      gate = null;
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(3);
      await hk.stop();
    });

    it("logs a poll the table refused and asks again next time, rather than throwing", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      let runs = 0;
      hk.register({
        name: "sweep",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () => {
          runs += 1;
          return Promise.resolve(null);
        },
      });
      await hk.start();
      const store = ctx.storage.housekeeping;
      const claimDue = store.claimDue.bind(store);
      store.claimDue = () => Promise.reject(dbError("SQLITE_BUSY"));
      const captured = captureLog();
      try {
        await expect(hk.poll()).resolves.toBeUndefined();
      } finally {
        captured.restore();
        store.claimDue = claimDue;
      }
      expect(captured.lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Housekeeping poll error",
        }),
      );
      expect(runs).toBe(0);
      // The witness: the same poll runs the job once the table answers.
      await hk.poll();
      await hk.settle();
      expect(runs).toBe(1);
      await hk.stop();
    });
  });

  describe("runNow", () => {
    it("runs a job inline and answers the run; unknown names are unknown", async () => {
      ctx = await createTestContext();
      const c = clock(T0);
      const hk = scheduler(c.nowFn);
      hk.register({
        name: "on-demand",
        intervalMs: 3_600_000,
        firstRunDelayMs: 3_600_000,
        run: () => {
          c.advance(50);
          return Promise.resolve({ swept: 3 });
        },
      });
      await hk.start();
      expect(await hk.runNow("on-demand")).toEqual({
        kind: "ran",
        run: {
          name: "on-demand",
          started_at: new Date(T0).toISOString(),
          finished_at: new Date(T0 + 50).toISOString(),
          outcome: "ok",
          result: { swept: 3 },
          error: null,
        },
      });
      // A run ahead of schedule leaves the schedule where it was.
      expect(
        (await ctx.storage.housekeeping.get("on-demand"))?.next_run_at,
      ).toBe(new Date(T0 + 3_600_000).toISOString());
      expect(await hk.runNow("nothing-here")).toEqual({ kind: "unknown" });
      await hk.stop();
    });

    it("answers a throw as the run's error outcome", async () => {
      ctx = await createTestContext();
      const hk = scheduler(clock(T0).nowFn);
      hk.register({
        name: "faulty",
        intervalMs: 3_600_000,
        firstRunDelayMs: 0,
        run: () => {
          return Promise.reject(new Error("no"));
        },
      });
      await hk.start();
      const captured = captureLog();
      const result = await hk.runNow("faulty");
      captured.restore();
      expect(result).toMatchObject({
        kind: "ran",
        run: { outcome: "error", error: "no", result: null },
      });
      await hk.stop();
    });
  });

  describe("stop", () => {
    it("waits for a run in flight", async () => {
      ctx = await createTestContext();
      const hk = scheduler(clock(T0).nowFn);
      let release: () => void = () => undefined;
      let finished = false;
      hk.register({
        name: "slow",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () =>
          new Promise<null>((done) => {
            release = () => {
              finished = true;
              done(null);
            };
          }),
      });
      await hk.start();
      await hk.poll();
      let stopped = false;
      const stopping = hk.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(finished).toBe(true);
      expect(stopped).toBe(true);
    });

    it("stands a run down at info when the client closed under it during shutdown, and keeps error otherwise", async () => {
      ctx = await createTestContext();
      const hk = scheduler(clock(T0).nowFn);
      hk.register({
        name: "interrupted",
        intervalMs: 60_000,
        firstRunDelayMs: 0,
        run: () => Promise.reject(dbError("CLIENT_CLOSED")),
      });
      await hk.start();

      const running = captureLog();
      await hk.runNow("interrupted");
      running.restore();
      expect(running.lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Housekeeping interrupted error",
        }),
      );

      // Shutdown stops the scheduler before it closes the client, so this
      // ordering is the one the process actually produces.
      await hk.stop();
      const stopped = captureLog();
      await hk.runNow("interrupted");
      stopped.restore();
      expect(stopped.lines).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Housekeeping interrupted stood down",
        }),
      );
    });
  });
});

describe("one scheduler owns every job's cadence and the level of its failure", () => {
  // The level was wrong in seven places because the rule was written seven
  // times, and a job that keeps its own timer is a job the table does not
  // list. The scheduler is the one place a failed run is classified; a job
  // module keeps no timer and calls no classifier.
  const here = (file: string) =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it("scheduler.ts classifies through logJobTickFailure and logs no error line of its own", () => {
    const source = here("./scheduler.ts");
    expect(source).toContain("logJobTickFailure(");
    expect(source).not.toContain('log("error"');
  });

  it.each([
    "../index.ts",
    "../storage/retention.ts",
    "../storage/version-thinner.ts",
    "../enrichment/sweeper.ts",
    "../bulk-actions/gc.ts",
    "../heartbeat.ts",
    "../webhooks/delivery.ts",
  ])("%s keeps no interval timer and classifies no failed run", (file) => {
    const source = here(file);
    expect(source).not.toContain("setInterval(");
    expect(source).not.toContain("logJobTickFailure(");
  });
});
