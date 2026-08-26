/**
 * What the scheduled-job chains have actually been doing, read off the
 * queue rows they already write.
 *
 * Every job logs at info only when a tick changed something, so a quiet
 * estate produces no lines and "nothing to do" reads exactly like "this
 * job has not run since the container booted". The enrichment sweep spent
 * three days believed stuck for that reason, and settling it took a
 * hand-written query against `pgboss.job` on a production box. The rows
 * were always there; nothing exposed them.
 *
 * Two things this deliberately is not:
 *
 *   - **Not a heartbeat log line.** A line an hour from every job is
 *     hundreds a day on an activity log already hard to read, and it
 *     answers "did it run" without answering "when did it last succeed"
 *     or "how long is it taking".
 *   - **Not driven by the queue table.** The job names come from the
 *     specs the process registered, and the queue rows are joined onto
 *     them. Reading the names out of `pgboss.job` instead would collapse
 *     the one case this exists for: a job with no rows would be absent
 *     from the answer, so "registered and never run" and "not a job on
 *     this deployment" would look identical.
 *
 * One thing it cannot separate: a job whose last tick is older than the
 * queue's retention has had that row deleted, so it reads exactly like a
 * job that has never ticked at all. Both come back with nulls. The
 * horizon is pg-boss's `deletion_seconds` (seven days by default), which
 * the payload does not carry, so a reader cannot date the silence — only
 * see that it is at least that long.
 *
 * Postgres only, because pg-boss is. A SQLite deployment runs the same
 * jobs on in-process timers and has no equivalent record, so nothing
 * installs a reporter there and the metrics section is absent rather
 * than empty — its absence says "no queue substrate", not "no ticks".
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "../storage/pg/connection.js";
import { queueNameFor } from "./pg-boss-schedules.js";

/**
 * How far back the tick count and the slowest tick look.
 *
 * Bounded by what pg-boss keeps: a completed row is deleted
 * `deletion_seconds` after it finished (seven days by default, and no
 * queue here overrides it), so a window past retention would count a
 * fraction of the ticks and report it as the whole. The query clamps to
 * the shortest retention across the scheduled queues rather than trusting
 * the default to stay put, and the clamped value is published as
 * `window_hours` so the count says what it covers.
 */
const DEFAULT_WINDOW_HOURS = 24;

export interface ScheduledJobTicks {
  /** The job's own name, not its queue name. */
  name: string;
  /** Last tick that finished. `null` means no completed tick is on record. */
  last_completed_at: string | null;
  /**
   * Last tick the queue itself failed, in one of three ways: the tick
   * outran its `expireInSeconds` budget, its process died mid-tick, or —
   * the one worth watching — its successor send failed, which leaves the
   * chain dead until the repair schedule restores it.
   *
   * Named for the queue rather than for the job because it is not "the
   * last time this job's work failed": every job catches its own failure,
   * logs it at error, and returns normally, so a tick whose work threw is
   * recorded as a completion. A field called `last_failed_at` would need
   * that caveat to be read correctly, and a name needing a caveat is the
   * defect this whole surface exists to close.
   */
  last_queue_failure_at: string | null;
  /** Ticks that finished inside the window, queue failures included. */
  ticks: number;
  /**
   * Longest completed tick inside the window, or `null` if none completed
   * in it. Queue failures are excluded: an abandoned tick stamps
   * `completed_on` at its expiry, so counting it would report the expiry
   * budget as a duration and send someone hunting a slow tick that never
   * ran.
   */
  slowest_tick_ms: number | null;
}

export interface ScheduledJobsReport {
  /** The window `ticks` and `slowest_tick_ms` cover. */
  window_hours: number;
  /** One entry per registered job, ordered by name. */
  jobs: ScheduledJobTicks[];
}

/** Produces the report for whatever deployment installed it, or
 *  `undefined` where there is nothing to report. */
export type ScheduledJobsReporter = () => Promise<
  ScheduledJobsReport | undefined
>;

let reporter: ScheduledJobsReporter | undefined;

/**
 * Install (or, with `undefined`, remove) the reporter `GET /metrics`
 * reads. Boot calls this once, on every process role that has a queue
 * substrate — the jobs execute on the worker but the endpoint serving
 * this lives on the web role, and both roles build the same spec list.
 */
export function setScheduledJobsReporter(
  next: ScheduledJobsReporter | undefined,
): void {
  reporter = next;
}

/** The installed reporter, or `undefined` where there is no queue. */
export function scheduledJobsReporter(): ScheduledJobsReporter | undefined {
  return reporter;
}

interface TickRow {
  [column: string]: unknown;
  job_name: string;
  /** The clamped window, repeated on every row. Never null: `LEAST` ignores
   *  the null a deployment with no tick rows produces, so the caller's own
   *  window is what survives. */
  window_seconds: number;
  last_completed_on: string | null;
  last_queue_failure_on: string | null;
  ticks: number;
  /** `bigint` reaches the driver as a string; coerced at the use site so a
   *  duration cannot leak into JSON as text. */
  slowest_tick_ms: string | number | null;
}

/** Postgres renders timestamps through `to_json` as ISO 8601 text, but with
 *  its microsecond + numeric-offset profile. Re-parse to the millisecond
 *  `Z` profile the rest of the API emits. */
function toIso(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * One query for every job, not one query per job: this hangs off an
 * endpoint an operator refreshes, and a round trip per job would make it
 * the slowest thing on the box.
 *
 * The registered names drive it and the queue rows join onto them, so a job
 * with nothing in `pgboss.job` still comes back — with nulls and a zero
 * count, which is exactly the "has not run since boot" reading.
 *
 * Last completion and last failure are unbounded by the window on purpose:
 * a job that last succeeded four days ago is the interesting case, and
 * clipping it to the window would report `null` and read as "never".
 */
export async function surveyScheduledJobs(
  db: PgDb,
  jobNames: string[],
  windowHours: number = DEFAULT_WINDOW_HOURS,
): Promise<ScheduledJobsReport | undefined> {
  // Nothing rather than an empty list: a section carrying `jobs: []` is
  // truthy, so it would publish and mean the same thing absence already
  // means. One way of saying nothing is enough.
  if (jobNames.length === 0) return undefined;

  const windowSeconds = Math.round(windowHours * 3600);
  // A VALUES list rather than an array parameter: the pair travels as two
  // ordinary text params per job, so nothing depends on how the driver
  // renders a JS array into a Postgres one.
  const registered = sql.join(
    jobNames.map((name) => sql`(${name}::text, ${queueNameFor(name)}::text)`),
    sql`, `,
  );

  const rows = await db.execute<TickRow>(sql`
    WITH registered(job_name, queue_name) AS (VALUES ${registered}),
    bound AS (
      -- Clamp to the shortest retention the tick rows themselves carry, so
      -- the count cannot cover less than it claims. Read off the job rows
      -- rather than off \`pgboss.queue\` because pg-boss copies
      -- \`deletion_seconds\` onto each job at insert and its own delete
      -- pass uses the row's copy: a queue whose retention was changed
      -- after rows existed has rows that outlive, or predecease, whatever
      -- the queue now advertises. \`LEAST\` ignores nulls, which is what
      -- makes the two "no bound to apply" cases fall through to the
      -- caller's window rather than to zero: there may be no rows at all
      -- yet, and \`NULLIF\` turns pg-boss's \`0\` — its "never delete" —
      -- into the same nothing.
      SELECT LEAST(
               ${windowSeconds}::int,
               min(NULLIF(j.deletion_seconds, 0))
             ) AS seconds
      FROM registered r
      LEFT JOIN pgboss.job j
        ON j.name = r.queue_name
       AND j.state IN ('completed', 'failed')
    )
    SELECT
      r.job_name,
      b.seconds AS window_seconds,
      to_json(max(j.completed_on) FILTER (WHERE j.state = 'completed')) #>> '{}'
        AS last_completed_on,
      to_json(max(j.completed_on) FILTER (WHERE j.state = 'failed')) #>> '{}'
        AS last_queue_failure_on,
      (count(j.id) FILTER (
        WHERE j.completed_on >= now() - b.seconds * interval '1 second'
      ))::int AS ticks,
      -- Completions only. pg-boss preserves \`started_on\` and stamps
      -- \`completed_on\` when it abandons a tick, so a failure has a
      -- duration too — roughly its expiry budget, eight minutes for the
      -- enrichment sweep. Reporting that as the slowest tick would invent
      -- a performance problem out of an outage.
      (max(
        (EXTRACT(EPOCH FROM (j.completed_on - j.started_on)) * 1000)::bigint
      ) FILTER (
        WHERE j.state = 'completed'
          AND j.started_on IS NOT NULL
          AND j.completed_on >= now() - b.seconds * interval '1 second'
      ))::bigint AS slowest_tick_ms
    FROM registered r
    CROSS JOIN bound b
    -- \`pgboss.job\` is the partitioned parent; these queues are not
    -- partitioned, so they share its default partition and the name
    -- predicate narrows through the primary-key index.
    LEFT JOIN pgboss.job j
      ON j.name = r.queue_name
     AND j.state IN ('completed', 'failed')
    GROUP BY r.job_name, b.seconds
    ORDER BY r.job_name
  `);

  return {
    // Every row carries the same bound, so folding them is a way of reading
    // one value without indexing into a list the type system cannot promise
    // is non-empty. The requested window seeds the fold: it is the loosest
    // answer there is, so it is what an empty result should mean.
    window_hours:
      Math.min(windowSeconds, ...rows.map((row) => row.window_seconds)) / 3600,
    jobs: rows.map((row) => ({
      name: row.job_name,
      last_completed_at: toIso(row.last_completed_on),
      last_queue_failure_at: toIso(row.last_queue_failure_on),
      ticks: row.ticks,
      slowest_tick_ms:
        row.slowest_tick_ms === null ? null : Number(row.slowest_tick_ms),
    })),
  };
}
