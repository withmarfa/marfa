/**
 * Postgres-backed scheduling for the server's recurring background jobs.
 *
 * On Postgres, the setInterval timers that carried retention, cleanup,
 * enrichment and webhook work move onto pg-boss: one scheduling substrate
 * instead of two, tick execution claimed through the database so exactly
 * one process in a deployment runs each tick (the outbound webhook poller
 * takes no advisory lock of its own, so duplicated timers double-deliver),
 * and — once containers split by role — the queue is what pins scheduled
 * work to the worker container instead of whichever process won a lock
 * that tick. SQLite keeps the in-process timers: pg-boss is Postgres-only,
 * and a SQLite deployment is single-process by definition.
 *
 * Mechanism, chosen over pg-boss's cron support because most of these
 * cadences are sub-minute and cron floors at a minute:
 *
 *   - One queue per job, policy `stately`: at most one queued and one
 *     active job, so chains cannot fork and re-seeding cannot duplicate.
 *   - The worker handler enqueues its own successor FIRST, `intervalMs`
 *     out, then runs the tick. The order is load-bearing: `stately` is
 *     one job per state, so while a tick is active the queued slot would
 *     otherwise sit empty, and the repair schedule's blind re-seed would
 *     be accepted into it — running the next tick at the short repair
 *     delay instead of the job's own interval, every time a tick outlived
 *     the repair cadence. Successor-first keeps the slot occupied for the
 *     whole tick, and doubles as crash insurance: a process that dies
 *     mid-tick leaves the chain's next link already queued.
 *   - Ticks that throw are logged and the chain continues — cadence is
 *     not a retry mechanism, and a failing job must not run hotter than
 *     its interval (matching the timers this replaces).
 *   - Every queue sets `expireInSeconds`. A tick whose process died holds
 *     the active slot, which blocks the queued successor from being
 *     fetched; expiry is what frees it, so its value bounds how long a
 *     hard crash can stall a job. pg-boss's default is fifteen minutes,
 *     which for a thirty-second job is an outage, not a bound.
 *   - A minutely repair schedule blindly re-seeds every chain. While a
 *     chain is alive (queued or active) the queue policy refuses the
 *     duplicate; a fully dead chain — both slots empty, e.g. after a
 *     successor send failed — is restored within a minute.
 *
 * Chains persist across restarts (jobs are rows), so a reboot neither
 * loses a schedule nor doubles it: the boot-time seed is refused while
 * the previous process's successor is still queued. Multiple processes
 * may call `startPgBossSchedules` against one database; every worker
 * races to claim each tick and the database hands it to exactly one.
 */
import type { PgBoss } from "pg-boss";
import { logJobTickFailure } from "../storage/job-tick.js";
import { log } from "../middleware/logger.js";

export interface ScheduledJobSpec {
  /**
   * Stable identifier; becomes the queue name, so it must stay within
   * pg-boss's `[A-Za-z0-9_.-/]` charset and must not change casually —
   * a renamed job strands the old chain until its queue is dropped.
   */
  name: string;
  /**
   * The job's name in sentence case, as it appears in its success log
   * line, so failure lines read as the same family (see job-tick.ts).
   */
  logName: string;
  intervalMs: number;
  /**
   * Boot-time stagger for a fresh chain's first tick, mirroring the
   * deliberate 5–30s spread the timer path gives first runs: boot is the
   * busiest the process ever is, and nothing here is urgent. Repair
   * re-seeds ignore this — a dead chain's recovery should be prompt.
   */
  firstRunDelaySeconds?: number;
  /**
   * Ceiling on one tick's runtime before the queue treats the claim as
   * abandoned and frees the active slot for the successor. Defaults to
   * twice the interval, floored at sixty seconds; set explicitly for
   * jobs whose ticks legitimately outrun that (enrichment's batch of
   * per-item OCR timeouts). Values at or above 24 hours are clamped to
   * the longest expiry pg-boss accepts, with a warn log naming the job,
   * so a tick budgeted past the clamp can be marked abandoned while
   * still running. An expired-but-still-running tick can overlap its
   * successor, which is why every job keeps its own cross-process
   * coordination lock rather than leaning on the queue.
   */
  expireInSeconds?: number;
  /** One tick. Failures are caught, logged and do not break the chain. */
  runOnce: () => Promise<unknown>;
}

export interface PgBossSchedulesOptions {
  /**
   * Threaded into tick-failure logging so a tick cut short by shutdown
   * reports as a stand-down rather than an error (see job-tick.ts).
   */
  isShuttingDown?: () => boolean;
  /**
   * Worker poll cadence override, for tests that need a short-interval
   * chain to tick inside a test budget. Production leaves it unset and
   * each queue polls in proportion to its own interval: a queue per job,
   * all on pg-boss's two-second default, is a steady stream of fetch
   * queries against a deliberately small pool, for jobs that mostly run
   * hourly. The number of them used to be spelled out here and had
   * already drifted by two, so it is not any more.
   */
  pollingIntervalSeconds?: number;
  /**
   * Deferral on seed and repair sends, overridable so tests neither wait
   * out the production value nor race it.
   */
  seedDelaySeconds?: number;
}

const QUEUE_PREFIX = "marfa.scheduled.";
export const REPAIR_QUEUE = "marfa.scheduled-repair";
const REPAIR_CRON = "* * * * *";

/**
 * Deferral on a seed or repair send. These only land when a chain is dead
 * (the queue policy refuses them otherwise), and a dead chain's next tick
 * should be prompt: deferring recovery by the job's own interval would
 * leave a broken daily chain silent for another day.
 */
const SEED_DELAY_SECONDS = 10;

/** pg-boss refuses `expireInSeconds` at or above 24 hours (its assert is
 *  `hours < 24`, strictly), so the ceiling here sits one second under.
 *  Exactly 86_400 crashed `createQueue` at boot for every daily-interval
 *  job, on the first deployment that ran this code against a real boss. */
const MAX_EXPIRE_SECONDS = 86_399;

export function queueNameFor(jobName: string): string {
  return `${QUEUE_PREFIX}${jobName}`;
}

/** pg-boss `startAfter` takes whole seconds; sub-second intervals exist
 *  only in tests and still get a real deferral. */
function intervalSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function defaultExpireSeconds(job: ScheduledJobSpec): number {
  // Unclamped on purpose: the single clamp lives at the createQueue call
  // every value (default or explicit) passes through.
  return Math.max(60, intervalSeconds(job.intervalMs) * 2);
}

/**
 * Poll cadence proportional to the job's own interval, bounded to
 * pg-boss's floor of two seconds and a minute at the top. A thirty-second
 * job polls hot enough that poll latency stays noise; an hourly job has
 * no business fetching every two seconds forever.
 */
function defaultPollingSeconds(job: ScheduledJobSpec): number {
  return Math.min(60, Math.max(2, intervalSeconds(job.intervalMs) / 20));
}

async function send(
  boss: PgBoss,
  job: ScheduledJobSpec,
  afterSeconds: number,
): Promise<void> {
  await boss.send(
    queueNameFor(job.name),
    {},
    {
      startAfter: afterSeconds,
      // A tick that throws is handled inside the worker handler; a retry
      // here would mean a second execution sooner than the interval.
      retryLimit: 0,
    },
  );
}

/**
 * Idempotent chain seeding: sends each job's next tick, and the `stately`
 * queue policy refuses the send whenever a successor is already queued or
 * a tick is active. Called at start and from the repair schedule; safe to
 * call any time.
 */
export async function repairSchedules(
  boss: PgBoss,
  jobs: ScheduledJobSpec[],
  seedDelaySeconds: number = SEED_DELAY_SECONDS,
  useFirstRunStagger = false,
): Promise<void> {
  for (const job of jobs) {
    const delay = useFirstRunStagger
      ? Math.max(seedDelaySeconds, job.firstRunDelaySeconds ?? 0)
      : seedDelaySeconds;
    await send(boss, job, delay);
  }
}

/**
 * Register workers and seed the chains. The boss instance is owned by the
 * caller (index.ts boots and stops it); this attaches to it and needs no
 * separate stop — `boss.stop({ graceful })` drains these workers with
 * everything else.
 */
export async function startPgBossSchedules(
  boss: PgBoss,
  jobs: ScheduledJobSpec[],
  options?: PgBossSchedulesOptions,
): Promise<void> {
  const isShuttingDown = options?.isShuttingDown ?? ((): boolean => false);
  const seedDelay = options?.seedDelaySeconds ?? SEED_DELAY_SECONDS;

  for (const job of jobs) {
    const queue = queueNameFor(job.name);
    const requestedExpire = job.expireInSeconds ?? defaultExpireSeconds(job);
    // The single clamp point: a spec asking for more than the boss allows
    // degrades to the longest legal expiry instead of crashing boot. Loud
    // only for EXPLICIT over-asks — a clamped explicit budget means a tick
    // can be marked abandoned while still running, which its author sized
    // against. The derived default reaching the ceiling is ordinary (every
    // daily job's twice-the-interval lands there) and warning for it would
    // teach operators to skip the line that matters.
    if (
      job.expireInSeconds !== undefined &&
      job.expireInSeconds > MAX_EXPIRE_SECONDS
    ) {
      log("warn", "Scheduled job expiry clamped to pg-boss's ceiling", {
        job: job.name,
        requested_seconds: job.expireInSeconds,
        clamped_seconds: MAX_EXPIRE_SECONDS,
      });
    }
    await boss.createQueue(queue, {
      policy: "stately",
      expireInSeconds: Math.min(requestedExpire, MAX_EXPIRE_SECONDS),
    });
    const workOptions = {
      batchSize: 1,
      pollingIntervalSeconds:
        options?.pollingIntervalSeconds ?? defaultPollingSeconds(job),
    };
    await boss.work(queue, workOptions, async () => {
      // Successor before tick — see the module doc. If this send fails
      // the tick is skipped and the handler throws; the chain is dead
      // until the repair schedule restores it within a minute, which is
      // the honest outcome when the database is refusing writes anyway.
      await send(boss, job, intervalSeconds(job.intervalMs));
      try {
        await job.runOnce();
      } catch (err) {
        logJobTickFailure(job.logName, err, isShuttingDown());
      }
    });
  }

  // Seed after the workers exist so a chain restored here is picked up
  // without waiting for a poll cycle on a queue nobody watches yet.
  await repairSchedules(boss, jobs, seedDelay, true);

  await boss.createQueue(REPAIR_QUEUE, { policy: "stately" });
  await boss.work(
    REPAIR_QUEUE,
    {
      batchSize: 1,
      pollingIntervalSeconds: options?.pollingIntervalSeconds ?? 60,
    },
    async () => {
      await repairSchedules(boss, jobs, seedDelay);
    },
  );
  await boss.schedule(REPAIR_QUEUE, REPAIR_CRON);
}
