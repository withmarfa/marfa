import type {
  HousekeepingOutcome,
  HousekeepingRow,
  HousekeepingStore,
} from "../storage/interface.js";
import { logJobTickFailure } from "../storage/job-tick.js";
import { log } from "../middleware/logger.js";

/**
 * One scheduler for the server's own periodic jobs, on a polling table.
 *
 * A job is registered from code at boot with its cadence and the function
 * that runs it; the table holds when each is next due and what its last
 * run did. The scheduler polls the table, claims each job that is due with
 * one conditional update (exclusive per name under SQLite's single writer),
 * runs it, and writes the outcome back. Jobs run concurrently across names
 * and never overlap themselves: one enrichment tick can legitimately take
 * minutes, and nothing else should wait behind it.
 *
 * Because the schedule is in the table, a restart keeps it: a daily job
 * that ran two hours before a deploy runs in twenty-two, not at boot. A
 * `running_since` found at boot was left by a process that died mid-run,
 * and is cleared with a log line; the job is due whenever its row says.
 */
export interface HousekeepingJob {
  /** Lowercase, hyphenated: the name in the table, the log and the door. */
  name: string;
  intervalMs: number;
  /** The wait before the first run on an instance that has never run the
   *  job, so boot, the busiest the process ever is, is not when every
   *  sweep starts. */
  firstRunDelayMs: number;
  /** One run. Whatever it resolves with is recorded as the run's result;
   *  a throw is recorded as its error. */
  run: () => Promise<unknown>;
}

export interface HousekeepingRun {
  name: string;
  started_at: string;
  finished_at: string;
  outcome: HousekeepingOutcome;
  result: unknown;
  error: string | null;
}

export type RunNowResult =
  | { kind: "ran"; run: HousekeepingRun }
  | { kind: "running" }
  | { kind: "unknown" };

export interface HousekeepingOptions {
  /** How often the table is asked what is due. */
  pollIntervalMs: number;
  nowFn?: () => Date;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export class Housekeeping {
  private readonly jobs = new Map<string, HousekeepingJob>();
  private readonly nowFn: () => Date;
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly store: HousekeepingStore,
    private readonly opts: HousekeepingOptions,
  ) {
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  register(job: HousekeepingJob): void {
    if (this.started) {
      throw new Error(`Housekeeping: ${job.name} registered after start`);
    }
    if (!NAME.test(job.name)) {
      throw new Error(`Housekeeping: ${job.name} is not a job name`);
    }
    if (this.jobs.has(job.name)) {
      throw new Error(`Housekeeping: ${job.name} registered twice`);
    }
    if (!(job.intervalMs > 0)) {
      throw new Error(`Housekeeping: ${job.name} needs a positive interval`);
    }
    this.jobs.set(job.name, job);
  }

  /** The registered names, for a caller that wants to know what runs. */
  names(): string[] {
    return [...this.jobs.keys()];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.nowFn();
    const existing = new Map(
      (await this.store.list()).map((row) => [row.name, row] as const),
    );
    for (const job of this.jobs.values()) {
      const row = existing.get(job.name);
      // An existing row keeps its own schedule unless it ran long enough
      // ago that the (possibly shortened) interval has already elapsed;
      // a new row waits out its first-run delay.
      const nextRunAt =
        row?.last_finished_at !== undefined && row.last_finished_at !== null
          ? addMs(row.last_finished_at, job.intervalMs)
          : addMs(now.toISOString(), job.firstRunDelayMs);
      await this.store.upsert(job.name, job.intervalMs, nextRunAt);
    }
    const removed = await this.store.removeExcept(this.names());
    if (removed.length > 0) {
      log("info", "Housekeeping rows without a registration removed", {
        names: removed,
      });
    }
    const cleared = await this.store.clearRunning();
    if (cleared.length > 0) {
      log("warn", "Housekeeping runs left unfinished by an earlier process", {
        names: cleared,
      });
    }
    this.schedulePoll();
  }

  /**
   * Stop polling and wait for runs in flight. The caller bounds the wait:
   * a run that outlives the bound loses its storage client when the caller
   * closes it, and its bookkeeping is classified as stood down.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** Make a job due now. Unknown names are ignored: a wake is a hint. */
  async wake(name: string): Promise<void> {
    await this.store.wake(name, this.nowFn().toISOString());
  }

  /** Run one job now, inline, and answer what it did. */
  async runNow(name: string): Promise<RunNowResult> {
    const job = this.jobs.get(name);
    if (!job) return { kind: "unknown" };
    const claimed = await this.store.claim(name, this.nowFn().toISOString());
    if (!claimed) {
      // A registered job with no row has not been started; to a caller
      // that is a job the instance does not run.
      return (await this.store.get(name))
        ? { kind: "running" }
        : { kind: "unknown" };
    }
    return { kind: "ran", run: await this.execute(job, claimed) };
  }

  list(): Promise<HousekeepingRow[]> {
    return this.store.list();
  }

  /** Wait for every run a poll has started. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.poll().finally(() => {
        this.schedulePoll();
      });
    }, this.opts.pollIntervalMs);
  }

  /**
   * One pass over what is due. Runs are started, not awaited. Nothing
   * here throws: a poll that fails to read or claim is logged and the next
   * poll asks again, because a rejection out of a timer ends the process.
   */
  async poll(): Promise<void> {
    if (this.stopped) return;
    const now = this.nowFn().toISOString();
    try {
      for (const name of await this.store.listDue(now)) {
        const job = this.jobs.get(name);
        if (!job) continue;
        const claimed = await this.store.claimDue(name, now);
        if (!claimed) continue;
        const running = this.execute(job, claimed).then(() => undefined);
        this.inFlight.add(running);
        void running.finally(() => this.inFlight.delete(running));
      }
    } catch (err) {
      logJobTickFailure("Housekeeping poll", err, this.stopped);
    }
  }

  private async execute(
    job: HousekeepingJob,
    claimed: HousekeepingRow,
  ): Promise<HousekeepingRun> {
    const startedAt = claimed.running_since ?? this.nowFn().toISOString();
    let outcome: HousekeepingOutcome = "ok";
    let result: unknown = null;
    let error: string | null = null;
    try {
      result = (await job.run()) ?? null;
    } catch (err) {
      outcome = "error";
      error = err instanceof Error ? err.message : String(err);
      logJobTickFailure(`Housekeeping ${job.name}`, err, this.stopped);
    }
    const finishedAt = this.nowFn().toISOString();
    try {
      await this.store.finish(job.name, {
        finishedAt,
        outcome,
        error,
        result,
        nextRunAt: addMs(finishedAt, job.intervalMs),
      });
    } catch (err) {
      // The run happened; only its record is lost. A record that meets the
      // closed client during shutdown is the ordinary end of a process,
      // and the classifier says so.
      logJobTickFailure(`Housekeeping ${job.name} record`, err, this.stopped);
    }
    return {
      name: job.name,
      started_at: startedAt,
      finished_at: finishedAt,
      outcome,
      result,
      error,
    };
  }
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}
