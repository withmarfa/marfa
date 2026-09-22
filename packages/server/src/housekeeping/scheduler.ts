import type {
  HousekeepingFinish,
  HousekeepingOutcome,
  HousekeepingRow,
  HousekeepingStore,
} from "../storage/interface.js";
import { logJobTickFailure } from "../storage/job-tick.js";
import { log } from "../middleware/logger.js";

/**
 * One scheduler for the server's own housekeeping, on a polling table.
 *
 * A housekeeping job is registered from code at boot with its cadence and
 * the function that runs it; the table holds when each is next due and
 * what its last run did. The scheduler polls the table, claims each name
 * that is due with one conditional update (exclusive per name under
 * SQLite's single writer), runs it, and writes the outcome back. Runs are
 * concurrent across names and never overlap on one name: one enrichment
 * run can legitimately take minutes, and nothing else should wait behind
 * it.
 *
 * Because the schedule is in the table, a restart keeps it: a daily sweep
 * that ran two hours before a deploy runs in twenty-two, not at boot. A
 * `running_since` found at boot was left by a run the last process never
 * finished, whether it died or stopped before the run could end, and is
 * cleared with a log line; the name is due whenever its row says.
 */
/**
 * What one run reports: a flat object of scalars, named by the job.
 *
 * Mostly counts — `{ deleted: 12 }`, `{ verified: 40, struck: 1 }` — and the
 * heartbeat reports whether its receiver answered, so booleans and a null
 * status belong too. Flat and scalar rather than anything at all: the doors
 * publish this, and a report a caller cannot read the type of is a report it
 * has to guess at.
 *
 * A type alias rather than an interface wherever a job's own result is
 * declared: an interface carries no index signature, so it cannot satisfy
 * this and the job would not compile.
 */
export type HousekeepingReport = Record<
  string,
  number | boolean | string | null
>;

export interface HousekeepingJob {
  /** Lowercase, hyphenated: the name in the table, the log and the door. */
  name: string;
  intervalMs: number;
  /** The wait before the first run on an instance that has never run this
   *  name, so boot, the busiest the process ever is, is not when every
   *  sweep starts. */
  firstRunDelayMs: number;
  /** One run. What it resolves with is recorded as the run's result and
   *  published on the housekeeping doors, so it is a count per name rather
   *  than anything a job feels like returning: `{ deleted: 12 }`,
   *  `{ verified: 40, struck: 1, bytes: 91_203 }`. A job with nothing to
   *  report resolves with `null` and the doors answer `last_result: null`
   *  for it. The compiler holding every registered job to this is what lets
   *  the document declare the shape instead of typing it unknown. A throw
   *  is recorded as the run's error. */
  run: () => Promise<HousekeepingReport | null>;
}

export interface HousekeepingRun {
  name: string;
  started_at: string;
  finished_at: string;
  outcome: HousekeepingOutcome;
  result: HousekeepingReport | null;
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
  /** Records a run could not write, kept for the next pass to write. */
  private readonly unrecorded = new Map<string, HousekeepingFinish>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The poll in progress, so `stop()` can let it finish claiming. */
  private polling: Promise<void> | null = null;
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
      throw new Error(
        `Housekeeping: ${job.name} is not a housekeeping job name`,
      );
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
   * Stop polling and wait for runs in flight. Polling stops before the
   * first await, so a caller that wants the poll off at once and the wait
   * later can hold the promise. The caller bounds the wait: a run that
   * outlives the bound loses its storage client when the caller closes it,
   * and its bookkeeping is classified as stood down.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A poll that was between its read and its claims when the flag went
    // up may still start a run, and a claim that waited on the write lock
    // is exactly such a gap: let the poll finish, so every run it started
    // is in flight before the wait below looks.
    if (this.polling) await this.polling;
    // Until empty rather than one snapshot: a run started on demand can
    // join while the server is still draining.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Make a name due now. Unknown names are ignored: a wake is a hint. */
  async wake(name: string): Promise<void> {
    await this.store.wake(name, this.nowFn().toISOString());
  }

  /** Run one name now, inline, and answer what it did. */
  runNow(name: string): Promise<RunNowResult> {
    const job = this.jobs.get(name);
    if (!job) return Promise.resolve({ kind: "unknown" });
    // Tracked from the claim, not from the run: `stop()` waits for a run
    // started on demand, and one whose claim was still waiting on the
    // write lock when the stop began is a run all the same.
    const attempt = this.claimAndRun(job);
    const tracked = attempt.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
    return attempt;
  }

  private async claimAndRun(job: HousekeepingJob): Promise<RunNowResult> {
    const claimed = await this.store.claim(
      job.name,
      this.nowFn().toISOString(),
    );
    if (!claimed) {
      // A registered name with no row has not been started; to a caller
      // that is a housekeeping job the instance does not run.
      return (await this.store.get(job.name))
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
    const pass = this.pass();
    this.polling = pass;
    try {
      await pass;
    } finally {
      if (this.polling === pass) this.polling = null;
    }
  }

  private async pass(): Promise<void> {
    const now = this.nowFn().toISOString();
    try {
      await this.writeUnrecorded();
      for (const name of await this.store.listDue(now)) {
        // `stop()` flips the flag while this loop awaits.
        if (this.stopped) break;
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
    let result: HousekeepingReport | null = null;
    let error: string | null = null;
    try {
      result = (await job.run()) ?? null;
    } catch (err) {
      outcome = "error";
      error = err instanceof Error ? err.message : String(err);
      logJobTickFailure(`Housekeeping ${job.name}`, err, this.stopped);
    }
    const finishedAt = this.nowFn().toISOString();
    const record: HousekeepingFinish = {
      finishedAt,
      outcome,
      error,
      result,
      nextRunAt: addMs(finishedAt, job.intervalMs),
    };
    try {
      await this.store.finish(job.name, record);
    } catch (err) {
      // The run happened; only its record is late. The claim marker stays
      // until the record lands, which the next pass tries again, so the
      // name is not run twice for one record and not stuck for want of
      // one. A record that meets the closed client during shutdown is the
      // ordinary end of a process, and the classifier says so.
      this.unrecorded.set(job.name, record);
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

  /** Records earlier runs could not write. A pass writes them before it
   *  claims anything, so a name held by a lost record is released. */
  private async writeUnrecorded(): Promise<void> {
    for (const [name, record] of this.unrecorded) {
      await this.store.finish(name, record);
      this.unrecorded.delete(name);
    }
  }
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}
