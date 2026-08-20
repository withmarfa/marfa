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
 *   - The worker handler runs the tick, then enqueues its own successor
 *     `intervalMs` out. Ticks that throw are logged and the chain
 *     continues — cadence is not a retry mechanism, and a failing job
 *     must not run hotter than its interval (matching the timers this
 *     replaces).
 *   - A minutely repair schedule blindly re-seeds every chain. While a
 *     chain is alive the queue policy refuses the duplicate, so repair is
 *     a no-op; when a crash between tick and re-send breaks a chain,
 *     repair restores it within a minute.
 *
 * Chains persist across restarts (jobs are rows), so a reboot neither
 * loses a schedule nor doubles it: the boot-time seed is refused while
 * the previous process's successor is still queued. Multiple processes
 * may call `startPgBossSchedules` against one database; every worker
 * races to claim each tick and the database hands it to exactly one.
 */
import type { PgBoss } from "pg-boss";
import { logJobTickFailure } from "../storage/job-tick.js";

export interface ScheduledJobSpec {
  /**
   * Stable identifier; becomes the queue name, so it must stay within
   * pg-boss's `[A-Za-z0-9_.-/]` charset and must not change casually —
   * a renamed job strands the old chain until its queue is dropped.
   */
  name: string;
  intervalMs: number;
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
   * chain to tick inside a test budget. Production leaves pg-boss's
   * default: these jobs' cadences are seconds to days, so poll latency
   * is noise there and a hotter poll is pure load.
   */
  pollingIntervalSeconds?: number;
}

const QUEUE_PREFIX = "marfa.scheduled.";
const REPAIR_QUEUE = "marfa.scheduled-repair";
const REPAIR_CRON = "* * * * *";

/**
 * Deferral on a seed or repair send. These only land when a chain is dead
 * (the queue policy refuses them otherwise), and a dead chain's next tick
 * should be prompt: deferring recovery by the job's own interval would
 * leave a broken daily chain silent for another day.
 */
const SEED_DELAY_SECONDS = 10;

export function queueNameFor(jobName: string): string {
  return `${QUEUE_PREFIX}${jobName}`;
}

/** pg-boss `startAfter` takes whole seconds; sub-second intervals exist
 *  only in tests and still get a real deferral. */
function intervalSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
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
 * queue policy refuses the send whenever a successor is already queued.
 * Called at start and from the repair schedule; safe to call any time.
 */
export async function repairSchedules(
  boss: PgBoss,
  jobs: ScheduledJobSpec[],
): Promise<void> {
  for (const job of jobs) {
    await send(boss, job, SEED_DELAY_SECONDS);
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
  const workOptions =
    options?.pollingIntervalSeconds === undefined
      ? { batchSize: 1 }
      : {
          batchSize: 1,
          pollingIntervalSeconds: options.pollingIntervalSeconds,
        };

  for (const job of jobs) {
    const queue = queueNameFor(job.name);
    await boss.createQueue(queue, { policy: "stately" });
    await boss.work(queue, workOptions, async () => {
      try {
        await job.runOnce();
      } catch (err) {
        logJobTickFailure(job.name, err, isShuttingDown());
      } finally {
        await send(boss, job, intervalSeconds(job.intervalMs));
      }
    });
  }

  // Seed after the workers exist so a chain restored here is picked up
  // without waiting for a poll cycle on a queue nobody watches yet.
  await repairSchedules(boss, jobs);

  await boss.createQueue(REPAIR_QUEUE, { policy: "stately" });
  await boss.work(REPAIR_QUEUE, workOptions, async () => {
    await repairSchedules(boss, jobs);
  });
  await boss.schedule(REPAIR_QUEUE, REPAIR_CRON);
}
