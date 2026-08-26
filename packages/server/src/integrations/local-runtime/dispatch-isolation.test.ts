/**
 * One job's outcome must not decide any other job's.
 *
 * A pg-boss batch is settled as a unit, in both directions. It arms one
 * expiry timer for the whole batch and, on timeout, fails every job id in
 * it — so dispatches that had already finished were re-queued and re-run
 * because a slower one was still going. And the handler ran the batch as a
 * plain `for ... await`, so one job's throw aborted the loop: the jobs
 * behind it were never attempted, and every one was failed carrying the
 * thrower's error. That reached the operator surface, where two dead-letter
 * rows for different connections both named the first connection.
 *
 * The isolation is a property of how the worker is REGISTERED rather than of
 * anything the handler does, so that is what these assert. Nothing the
 * handler could do would undo a batch-wide settlement, which is why the
 * remedy is the registration and why these read it.
 *
 * The handler itself is covered elsewhere: `supervisor.test.ts` drives the
 * registered callback with a two-job batch to pin that the queue job's
 * abort signal reaches the dispatch. That test is not made redundant by
 * this file and must not be removed on the grounds that batches are now
 * one job long.
 *
 * No database. These read the options the supervisor hands pg-boss.
 */
import { describe, it, expect } from "vitest";
import { createSupervisor, QUEUE_NAME } from "./supervisor.js";
import type { LocalIntegrationRegistration } from "./types.js";
import type { Storage } from "../../storage/interface.js";
import type { PgBoss } from "pg-boss";
import { TEST_API_KEY_SALT } from "../../test-utils.js";
import { SESSION_POOL_MAX_CONNECTIONS } from "../../storage/pg/connection.js";

const unusedStorage = {} as Storage;

const noopExecutor = {
  dispatch: () =>
    Promise.resolve({
      result: { ok: true as const },
      cursorUpdates: {},
      cursorDeletes: [],
      threw: false,
    }),
  terminate: () => Promise.resolve(),
};

const registration: LocalIntegrationRegistration = {
  name: "test/dispatch-isolation",
  handlerModulePath: null,
  directDispatch: () =>
    Promise.resolve({
      result: { ok: true as const },
      cursorUpdates: {},
      cursorDeletes: [],
      threw: false,
    }),
  scheduleCron: "*/5 * * * *",
  echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
  triggerKinds: new Set(["schedule"]),
};

/** Records the options every `work` registration was made with. */
function recordingBoss() {
  const work: { queue: string; options: Record<string, unknown> }[] = [];
  const boss = {
    createQueue: () => Promise.resolve(),
    schedule: () => Promise.resolve(),
    unschedule: () => Promise.resolve(),
    getSchedules: () => Promise.resolve([]),
    send: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    work: (queue: string, options: Record<string, unknown>) => {
      work.push({ queue, options });
      return Promise.resolve();
    },
  };
  const dispatchQueue = (): Record<string, unknown> => {
    const found = work.find((w) => w.queue === QUEUE_NAME);
    if (!found) throw new Error("no worker registered on the dispatch queue");
    return found.options;
  };
  return { boss: boss as unknown as PgBoss, dispatchQueue };
}

function supervisorWith(
  boss: PgBoss,
  dispatchConcurrency?: number,
): ReturnType<typeof createSupervisor> {
  return createSupervisor(unusedStorage, {
    apiUrl: "http://test.local",
    apiKeySalt: TEST_API_KEY_SALT,
    authMode: "keys",
    registrations: [registration],
    executor: noopExecutor,
    boss,
    ...(dispatchConcurrency !== undefined && { dispatchConcurrency }),
  });
}

describe("dispatch isolation", () => {
  it("takes one job per fetch, so a batch has no siblings to fail", async () => {
    // The guard for both halves. At any batch size above one, a timeout
    // fails every job id in the batch and a throw abandons the jobs behind
    // it — neither of which the handler can undo, because pg-boss settles
    // the batch as a unit.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss).start();

    expect(dispatchQueue().batchSize).toBe(1);
  });

  it("runs more than one dispatch at a time", async () => {
    // pg-boss defaults `localConcurrency` to 1, and its worker awaits the
    // handler before fetching again. Inheriting that made one slow dispatch
    // a total stop for every integration on the process rather than for its
    // own connection.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss).start();

    const concurrency = dispatchQueue().localConcurrency;
    expect(typeof concurrency).toBe("number");
    expect(concurrency as number).toBeGreaterThan(1);
  });

  it("leaves most of the session pool for everything else", async () => {
    // A dispatch holds a reserved session connection for its whole run, and
    // no setting raises that pool above its ceiling — `MARFA_DB_POOL_SIZE`
    // can only lower it. Streaming reads, the consent lock and every other
    // job-lock tick compete for the same five, and one of those is on a
    // request path that turns a lost reservation into a user-visible
    // refusal. A default claiming most of the pool for dispatch would turn
    // ordinary contention into dispatches acked and dropped at a lock
    // nobody holds.
    //
    // Derived from the pool's own constant rather than restated, so
    // lowering the ceiling moves this with it instead of leaving a literal
    // that passes at a default which would now exhaust the pool.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss).start();

    const concurrency = dispatchQueue().localConcurrency as number;
    expect(concurrency).toBeLessThanOrEqual(
      Math.floor(SESSION_POOL_MAX_CONNECTIONS / 2),
    );
  });

  it("honors an operator override, ceiling or no ceiling", async () => {
    // Deliberately unclamped. An operator who has read what the pool costs
    // and decided dispatch should have more of it is making a trade about
    // who else goes without, and a silent clamp would leave them believing
    // they had made it. The refusal to guess is the point.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss, 5).start();

    expect(dispatchQueue().localConcurrency).toBe(5);
  });

  it("polls often enough to pay for the smaller batch", async () => {
    // pg-boss sleeps once per fetch however many jobs the fetch returned,
    // so a batch of four amortised the poll delay over four jobs and a
    // batch of one does not. Its own remedy is unavailable: burst mode is
    // documented as ignored when the batch size is one. Halving the
    // interval is what pays for it, and without this the change is a
    // throughput regression at any dispatch shorter than the interval.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss).start();

    expect(
      dispatchQueue().pollingIntervalSeconds as number,
    ).toBeLessThanOrEqual(1);
  });

  it("still carries the metadata the redelivery rule reads", async () => {
    // `retryCount` is what tells a first delivery from a redelivery, which
    // decides whether a handler throw earns a retry. Losing it while
    // reshaping the registration would be silent: the field simply reads as
    // missing.
    const { boss, dispatchQueue } = recordingBoss();
    await supervisorWith(boss).start();

    expect(dispatchQueue().includeMetadata).toBe(true);
  });
});
