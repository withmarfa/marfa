import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BulkActionJobRow,
  BulkActionJobStore,
  Storage,
} from "../storage/interface.js";
import {
  validateRequestAuthority,
  withRequestAuthority,
} from "../auth/request-authority.js";
import { DrizzleQueryError } from "drizzle-orm";
import { LibsqlError } from "@libsql/client";
import { BulkActionWorker } from "./worker.js";

/**
 * Empty matched IDs isolate polling and completion from chunk execution,
 * so these tests need no item storage or chunk-authority fixtures.
 */
function makeRow(): BulkActionJobRow {
  return {
    id: "job_1",
    api_key_id: null,
    credential: "fixture",
    status: "in_progress",
    action: "transition",
    input: JSON.stringify({ action: "transition", state: "trashed" }),
    matched_ids: "[]",
    matched_count: 0,
    claim_generation: 1,
    next_offset: 0,
    checkpoint_json: '{"ids":[],"errors":[]}',
    blob_hashes_referenced_count: 0,
    processed_count: 0,
    succeeded_count: 0,
    errored_count: 0,
    result: null,
    error: null,
    worker_id: "w",
    worker_heartbeat_at: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
  };
}

interface StubControls {
  storage: Storage;
  /** Number of `claimNext` calls so far == number of ticks that have run. */
  ticks(): number;
  /** Queue the next `claimNext` to return a job exactly once. */
  enqueueJob(): void;
}

function makeStubStorage(): StubControls {
  let claimCount = 0;
  let pendingJob = false;
  const jobs: Partial<BulkActionJobStore> = {
    recoverStale: () => Promise.resolve(0),
    claimNext: () => {
      claimCount += 1;
      if (pendingJob) {
        pendingJob = false;
        return Promise.resolve(makeRow());
      }
      return Promise.resolve(null);
    },
    getById: () => Promise.resolve(makeRow()),
    completeOwned: () => Promise.resolve(true),
    failOwned: () => Promise.resolve(true),
  };
  const storage = { bulkActionJobs: jobs as BulkActionJobStore } as Storage;
  return {
    storage,
    ticks: () => claimCount,
    enqueueJob: () => {
      pendingJob = true;
    },
  };
}

describe("BulkActionWorker idle-poll backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("widens the empty-poll interval geometrically from the base", async () => {
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    // start() recovers stale jobs then schedules the first tick at 0ms.
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.ticks()).toBe(1); // first tick fired; queue empty → arm at 1000

    // Next tick must not fire before the full 1000ms (500 base * 2).
    await vi.advanceTimersByTimeAsync(999);
    expect(stub.ticks()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.ticks()).toBe(2); // 500 → 1000; now armed at 2000

    // The interval doubled: the third tick lands at 2000ms, not 1000.
    await vi.advanceTimersByTimeAsync(1999);
    expect(stub.ticks()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.ticks()).toBe(3); // 1000 → 2000; armed at 4000

    await worker.stop();
  });

  it("caps the backoff at maxPollIntervalMs", async () => {
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0); // tick 1, arm at 1000

    // Walk the doublings up to and past the ceiling: the armed delay goes
    // 1000, 2000, 4000, 8000, 16000, 32000, then 64000 clamped to 60000.
    const expectedDelays = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000];
    let expectedTicks = 1;
    for (const delay of expectedDelays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(stub.ticks()).toBe(expectedTicks); // not yet
      await vi.advanceTimersByTimeAsync(1);
      expectedTicks += 1;
      expect(stub.ticks()).toBe(expectedTicks);
    }

    // Once capped, the interval holds at 60000 — it does not keep growing.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stub.ticks()).toBe(expectedTicks);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.ticks()).toBe(expectedTicks + 1);

    await worker.stop();
  });

  it("resets the interval to the base when a job is claimed", async () => {
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0); // tick 1, empty → arm at 1000
    await vi.advanceTimersByTimeAsync(1000); // tick 2, empty → arm at 2000
    await vi.advanceTimersByTimeAsync(2000); // tick 3, empty → arm at 4000
    expect(stub.ticks()).toBe(3);

    // A job is waiting for the next claim: that tick runs it, resets the
    // backoff to the base, and re-arms the hot path at 0ms. Advancing 1ms
    // flushes both the claiming tick (4) and the immediate hot follow-up
    // (5), which finds the queue empty again and re-arms at the base 1000.
    stub.enqueueJob();
    await vi.advanceTimersByTimeAsync(4000); // tick 4 claims the job, arm at 0
    expect(stub.ticks()).toBe(4);
    await vi.advanceTimersByTimeAsync(1); // tick 5 (hot, delay 0) → empty → 1000
    expect(stub.ticks()).toBe(5);

    // Proof the base was restored: the next empty gap is ~1000ms (the base
    // doubled once), not the 8000ms it would be had the 4000 backoff carried
    // through. A no-tick at +900 then a tick by +1100 brackets it cleanly and
    // rules out 8000.
    await vi.advanceTimersByTimeAsync(900);
    expect(stub.ticks()).toBe(5);
    await vi.advanceTimersByTimeAsync(200);
    expect(stub.ticks()).toBe(6);

    await worker.stop();
  });
});

// ---------------------------------------------------------------------------
// wake() — enqueue does not wait out the idle backoff
// ---------------------------------------------------------------------------

/**
 * The backoff above is correct and was also the entire pickup latency.
 *
 * It widens to a sixty-second ceiling while the queue is quiet, and nothing
 * shortened it, so a job arriving into a settled worker waited out whatever
 * interval happened to be pending. Measured on staging: thirty-two seconds
 * queued, then sixty-five milliseconds of work, on a warm container — so it
 * was not a cold start.
 *
 * These drive the same fake clock as the backoff tests, because the property
 * is about *when* the next tick fires, and a real-clock test would only be
 * able to say "quickly".
 */
describe("BulkActionWorker.wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("REGRESSION: a settled worker ticks immediately instead of waiting out the backoff", async () => {
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    // Let the backoff widen. After these the armed delay is 60s: the state
    // a worker settles into between bursts, and the one the reported job
    // arrived into.
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    const settled = stub.ticks();

    // Nothing happens for a long while — this is the defect.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.ticks()).toBe(settled);

    // An enqueue arrives.
    worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.ticks()).toBe(settled + 1);

    await worker.stop();
  });

  it("resets the backoff, so the tick after a wake is at the base cadence", async () => {
    // Waking once without resetting would fire one prompt tick and then
    // return to a minute of silence, which is the same defect one job later.
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    const afterWake = stub.ticks();

    // The empty poll from the woken tick re-widens from the base (500 * 2),
    // not from the ceiling.
    await vi.advanceTimersByTimeAsync(999);
    expect(stub.ticks()).toBe(afterWake);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.ticks()).toBe(afterWake + 1);

    await worker.stop();
  });

  it("collapses a burst of enqueues into one tick", async () => {
    // Every enqueue in a batch signals. Arming one timer per signal would
    // turn a bulk import into a tick storm against the database.
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = stub.ticks();

    for (let i = 0; i < 20; i++) worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.ticks()).toBe(before + 1);

    await worker.stop();
  });

  it("does not arm a second timer when a tick is already running", async () => {
    // The burst test above passes with or without the in-flight guard,
    // because clearing the pending timer is what collapses a burst. This is
    // the case the guard is actually for: waking mid-tick would arm a timer
    // that the running tick's own re-arm then orphans, leaving two live
    // timers and a duplicate tick.
    let release: (() => void) | undefined;
    let claims = 0;
    const jobs: Partial<BulkActionJobStore> = {
      recoverStale: () => Promise.resolve(0),
      claimNext: () => {
        claims += 1;
        // Hold the first tick open so wake() lands while it is in flight.
        if (claims === 1) {
          return new Promise<null>((resolve) => {
            release = () => {
              resolve(null);
            };
          });
        }
        return Promise.resolve(null);
      },
      getById: () => Promise.resolve(makeRow()),
      completeOwned: () => Promise.resolve(true),
      failOwned: () => Promise.resolve(true),
    };
    const worker = new BulkActionWorker({
      storage: { bulkActionJobs: jobs as BulkActionJobStore } as Storage,
      pollIntervalMs: 500,
      maxPollIntervalMs: 60_000,
      pollBackoffMultiplier: 2,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(1); // in flight, awaiting claimNext

    worker.wake();
    worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    // Still one: the guard refused to arm behind a running tick.
    expect(claims).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    // The running tick re-armed from the reset base — an empty poll widens
    // before arming, so 500 doubles to 1000 — and exactly one timer is
    // live, so exactly one further tick lands there rather than two.
    await vi.advanceTimersByTimeAsync(999);
    expect(claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(2);

    await worker.stop();
  });

  it("does nothing once stopped", async () => {
    const stub = makeStubStorage();
    const worker = new BulkActionWorker({ storage: stub.storage });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = stub.ticks();

    await worker.stop();
    worker.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stub.ticks()).toBe(before);
  });
});

describe("BulkActionWorker and the request that woke it", () => {
  it("runs its jobs outside the authority of that request, whose credential may be revoked since", async () => {
    const stub = makeStubStorage();
    let completed = false;
    (stub.storage.bulkActionJobs as Partial<BulkActionJobStore>).completeOwned =
      async () => {
        // A write commit asks the authority of the request it runs under.
        await validateRequestAuthority();
        completed = true;
        return true;
      };
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 60_000,
      maxPollIntervalMs: 60_000,
    });
    try {
      await worker.start();
      let asked = false;
      stub.enqueueJob();
      await withRequestAuthority(
        () => {
          asked = true;
          return Promise.reject(new Error("the credential was revoked"));
        },
        () => {
          worker.wake();
          return Promise.resolve();
        },
      );
      await vi.waitFor(() => {
        expect(completed).toBe(true);
      });
      expect(asked).toBe(false);
    } finally {
      await worker.stop();
    }
  });
});

describe("BulkActionWorker and a failed tick", () => {
  const VALUE = "bound-value-7c41f0aa";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The tick lines `log()` writes when a worker's claim rejects with `fail`, before or after the worker is told to stop. */
  async function linesFromTick(
    fail: Error,
    stopFirst: boolean,
  ): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      return true;
    });
    const stub = makeStubStorage();
    let reject!: (error: Error) => void;
    (stub.storage.bulkActionJobs as Partial<BulkActionJobStore>).claimNext =
      () =>
        new Promise((_, rejected) => {
          reject = rejected;
        });
    const worker = new BulkActionWorker({
      storage: stub.storage,
      pollIntervalMs: 500,
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    if (stopFirst) {
      const stopping = worker.stop();
      reject(fail);
      await stopping;
    } else {
      reject(fail);
      await vi.advanceTimersByTimeAsync(0);
      await worker.stop();
    }
    return lines.filter((line) => String(line.message).includes("tick"));
  }

  const closed = () => new LibsqlError("The client is closed", "CLIENT_CLOSED");

  it("keeps the code of a closed client in the error line", async () => {
    const lines = await linesFromTick(closed(), false);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        error: expect.stringContaining("CLIENT_CLOSED") as unknown,
      }),
    );
  });

  it("logs a tick that failed after the worker was told to stop at info", async () => {
    const lines = await linesFromTick(closed(), true);
    expect(lines.map((line) => line.level)).toEqual(["info"]);
  });

  it("puts no statement text and no bound value in the line", async () => {
    const failure = new DrizzleQueryError(
      'insert into "items" ("body") values (?)',
      [VALUE],
      closed(),
    );
    // Witness: the error as the query layer raises it holds the value.
    expect(failure.message).toContain(VALUE);
    const lines = await linesFromTick(failure, false);
    expect(lines).not.toHaveLength(0);
    for (const line of lines) {
      const text = JSON.stringify(line);
      expect(text).toContain("CLIENT_CLOSED");
      expect(text).not.toContain(VALUE);
      expect(text).not.toContain("insert into");
    }
  });
});
