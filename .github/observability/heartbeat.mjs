/**
 * Watching the watcher.
 *
 * Every check in this workflow answers "is the fleet healthy?". None of them
 * answers "is anything still asking?" — and a monitor that silently stops is
 * indistinguishable from a fleet that is fine. Both produce no alerts.
 *
 * Three mechanisms close that gap, because no single one can:
 *
 *   1. **Emit** a heartbeat event on every run, red or green. Its *absence*
 *      in the telemetry backend is the signal that the watcher stopped, and
 *      an absence can be alerted on from outside this repository entirely
 *      (see the workflow header for how to wire that).
 *   2. **Read** the recent heartbeats at the start of each run. This cannot
 *      detect a watcher that never comes back, but it does detect one that
 *      stopped and resumed — the common case, since scheduled workflows are
 *      disabled after a period of repository inactivity and silently resume
 *      when someone pushes. That gap would otherwise leave no trace.
 *   3. **Assert** that the project written to is the project read from. Those
 *      are two separate pieces of configuration with nothing tying them
 *      together, and if they ever name different projects then both readers
 *      here find no rows and report nothing wrong — silently, permanently,
 *      and looking exactly like health.
 *
 * ## Nothing here may assume the schedule interval
 *
 * The workflow asks for a run every five minutes. It does not get one: GitHub
 * drops scheduled runs under load rather than queueing them, and the interval
 * this repository actually receives is over an hour, with a tail past three.
 * Any constant derived from the cron line is therefore wrong by more than an
 * order of magnitude, and wrong in the direction that makes the gap check
 * fire on every single run while making the oscillation check unreachable.
 *
 * So the tolerance below is derived from the intervals the scheduler has
 * recently been delivering, read back out of the heartbeat history itself,
 * and the oscillation window is counted in runs rather than minutes. Both
 * hold whatever the scheduler does, including if it is ever fixed.
 */

const HEARTBEAT_EVENT = "marfa_watchdog_heartbeat";

/**
 * Only scheduled runs establish the rhythm this file reasons about.
 *
 * The same workflow also runs on pull requests, on manual dispatch, and by
 * hand from a developer machine, and each of those emits a heartbeat too —
 * deliberately, since an emit that fails is worth seeing before merge. But
 * they arrive in bursts seconds apart, and mixing them in would drag the
 * observed interval towards zero and make a tolerance derived from it fire on
 * the next genuinely scheduled run. Every heartbeat therefore records what
 * triggered it, and everything below reads only the scheduled ones.
 */
const SCHEDULED_TRIGGER = "schedule";

/**
 * How far back to read, and how many rows to take.
 *
 * The lookback is the hard ceiling on the largest gap this can report at all:
 * once the previous heartbeat falls outside it, the history is empty and the
 * outage cannot be distinguished from a first-ever run. A month covers the
 * usual cause, a schedule disabled for repository inactivity and revived
 * weeks later by an unrelated push.
 *
 * The row limit is well above what either check needs — at the delivered
 * interval it spans several days — and is there to bound the response.
 */
const HISTORY_LOOKBACK_DAYS = 30;
const HISTORY_LIMIT = 64;

/**
 * How stale the previous heartbeat may be before the gap is reported,
 * expressed as a multiple of the interval recently being delivered.
 *
 * A constant was the original bug: 30 minutes, chosen as "several times the
 * schedule interval", turned out to be under half of it, so the warning fired
 * on every run. A warning that is always present is a warning nobody reads,
 * on the one mechanism whose entire job is to be believed when it fires.
 *
 * The multiple has to clear the *widest* interval the scheduler produces, not
 * the typical one, because the distribution has a long right tail: measured
 * intervals ran from just under an hour to nearly four, against a median of
 * about an hour and a quarter. Four times the median clears the widest
 * measured interval with room to spare. The trade is deliberate — a blackout
 * not much longer than the scheduler's own worst day cannot be told apart
 * from one, so it goes unreported rather than reported unreliably.
 *
 * The baseline is the **median**, not the mean or the maximum, so a single
 * long outage entering the history cannot desensitize the check afterwards.
 * The gap being judged is never itself in the baseline: this run has not
 * emitted its heartbeat yet.
 */
const GAP_TOLERANCE_MULTIPLE = 4;

/**
 * A floor under the derived tolerance, in minutes.
 *
 * This one is not about cadence, it is about attention: under an hour of
 * blindness is not worth interrupting anybody for, whatever interval the
 * scheduler happens to be delivering. It also keeps the tolerance sane if the
 * schedule ever starts running at anything near the rate it asks for.
 */
const MIN_GAP_TOLERANCE_MINUTES = 60;

/**
 * How many observed intervals it takes before the median is worth believing.
 * Below this there is no established rhythm to have deviated from, so no gap
 * is reported — which is also what keeps a first-ever run quiet.
 */
const MIN_GAPS_FOR_BASELINE = 5;

/**
 * How far back to look when deciding whether the fleet is oscillating between
 * healthy and unhealthy across separate runs, and how many flips it takes.
 *
 * Within-run sampling catches a surface that fails some requests and serves
 * others in the same minute. It cannot catch the slower pattern — healthy for
 * one run, broken for the next, healthy again — where every individual run
 * reaches a consistent verdict and only the sequence looks wrong. Each run
 * already records its verdict on the heartbeat, so that sequence is free to
 * read and needs no state of its own.
 *
 * **The window is a number of runs, not a number of minutes.** A minute-based
 * window silently couples this threshold to the delivery rate: at the rate
 * actually delivered, the ninety-minute window this started with held one or
 * two runs, and three flips need at least four runs to sit between, so the
 * check could not fire at all. Counting runs makes the threshold reachable at
 * any cadence, and the elapsed span is measured and reported in the finding
 * rather than assumed.
 *
 * Three flips is two full cycles: enough that a single recovery or a single
 * new failure does not register, since those are one flip each and are
 * already reported by the alert issue opening or closing. Six runs is the
 * narrowest window that still leaves headroom above the threshold, so a red
 * finding means most of the recent sequence was transitions rather than one
 * disturbance sitting at the edge of a wide window.
 */
const OSCILLATION_RUN_WINDOW = 6;
const OSCILLATION_THRESHOLD = 3;

/**
 * Parse a timestamp from the telemetry backend.
 *
 * A bare datetime with no zone marker would be read as runner-local time, and
 * every duration computed from it would be wrong by the offset. These are
 * always UTC, so say so explicitly rather than inheriting whatever the
 * runner's clock is configured with.
 */
function parseTimestamp(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Read a run verdict, or `null` if the value is not one.
 *
 * Verdicts arrive as booleans today. The two exact strings are accepted as
 * well, because the alternative failure is silent and total: if the backend
 * ever serializes its boolean column as text, a reader that insists on the
 * JavaScript type discards every row and reports a fleet that never flaps.
 * Anything else is still ignored rather than guessed at, so a malformed
 * record cannot manufacture a flip.
 */
function readVerdict(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Send the heartbeat. Best effort: a telemetry backend that will not accept
 * an event must never be the reason a real fleet alert fails to be raised.
 */
export async function emitHeartbeat({ env, runId, healthy }) {
  const key = env.POSTHOG_INGESTION_KEY;
  const host = env.POSTHOG_INGESTION_HOST;
  if (!key || !host) return { emitted: false, reason: "not configured" };

  try {
    const response = await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event: HEARTBEAT_EVENT,
        distinct_id: "marfa-observability-workflow",
        properties: {
          run_id: runId,
          healthy,
          // What caused this run. Everything that reads the history back
          // filters on it, so pull-request, dispatch, and local runs cannot
          // pollute the schedule's observed rhythm.
          trigger: env.GITHUB_EVENT_NAME ?? "local",
          $process_person_profile: false,
        },
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { emitted: response.ok, status: response.status };
  } catch (error) {
    return {
      emitted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read recent scheduled heartbeats, newest first.
 *
 * One query serves both checks below: they want the same rows, and the query
 * API is rate-limited per hour.
 *
 * Rows are selected rather than aggregates, and that is load-bearing. An
 * earlier version asked for `max(timestamp)`, which hides a trap: an
 * aggregate over zero matching rows does not come back empty, it comes back
 * as the column type's zero value, which parses as a date in 1970 and reads
 * as a gap of several decades. A list of rows makes "nothing recorded" an
 * empty array, which cannot be mistaken for an ancient heartbeat.
 */
export async function fetchHeartbeatHistory({ env }) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const host = env.POSTHOG_HOST;
  const projectId = env.POSTHOG_PROJECT_ID_PROD;
  if (!apiKey || !host || !projectId) {
    return { configured: false, beats: [] };
  }

  const query =
    "SELECT timestamp, properties.healthy FROM events " +
    `WHERE event = '${HEARTBEAT_EVENT}' ` +
    `AND properties.trigger = '${SCHEDULED_TRIGGER}' ` +
    `AND timestamp >= now() - INTERVAL ${String(HISTORY_LOOKBACK_DAYS)} DAY ` +
    `ORDER BY timestamp DESC LIMIT ${String(HISTORY_LIMIT)}`;

  try {
    const response = await fetch(
      `${host}/api/projects/${String(projectId)}/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return { configured: true, unknown: true, beats: [] };

    const payload = await response.json();
    const beats = (payload.results ?? [])
      .map((row) => ({ at: parseTimestamp(row[0]), healthy: row[1] }))
      .filter((beat) => beat.at !== null);
    return { configured: true, beats };
  } catch {
    return { configured: true, unknown: true, beats: [] };
  }
}

/**
 * Count healthy/unhealthy transitions in a sequence of run verdicts.
 *
 * Exported and pure: the ordering and the definition of a "flip" are the part
 * worth reasoning about without a network. Entries that cannot be read as a
 * verdict are dropped rather than guessed at.
 */
export function countOscillations(verdicts) {
  const clean = verdicts.map(readVerdict).filter((v) => v !== null);
  let flips = 0;
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i] !== clean[i - 1]) flips += 1;
  }
  return flips;
}

/**
 * Intervals in minutes between consecutive heartbeats, in either order.
 * Exported so the derivation can be exercised against intervals a real
 * scheduler produced rather than only against invented ones.
 */
export function heartbeatIntervals(beats) {
  const gaps = [];
  for (let i = 1; i < beats.length; i += 1) {
    const delta = beats[i - 1].at.getTime() - beats[i].at.getTime();
    gaps.push(Math.abs(delta) / 60_000);
  }
  return gaps;
}

/**
 * The staleness tolerance implied by a set of observed intervals, or `null`
 * when there are too few of them to establish a rhythm.
 *
 * Pure and exported so a test can assert the tolerance clears the intervals
 * this workflow's scheduler actually delivers. That assertion is the guard
 * against the original defect returning: the arithmetic was never wrong, it
 * was the relationship between the constants and the environment that broke.
 */
export function heartbeatGapTolerance(gapMinutes) {
  if (gapMinutes.length < MIN_GAPS_FOR_BASELINE) return null;
  const baseline = median(gapMinutes);
  return {
    baselineMinutes: Math.round(baseline),
    toleranceMinutes: Math.max(
      MIN_GAP_TOLERANCE_MINUTES,
      Math.round(baseline * GAP_TOLERANCE_MULTIPLE),
    ),
    samples: gapMinutes.length,
  };
}

/**
 * Report whether the watcher had a gap, judged against its own recent rhythm.
 *
 * Pure — the network call is `fetchHeartbeatHistory`. Splitting the two is
 * what lets the thresholds be tested against a real interval distribution.
 */
export function checkHeartbeatGap({ history, now }) {
  if (!history.configured) return { configured: false, findings: [] };
  if (history.unknown) {
    // Fails closed, so the summary has to say so. A reader that cannot reach
    // its backend and therefore reports nothing wrong is the exact shape of
    // failure this workflow exists to catch; it must not be invisible.
    return { configured: true, unknown: true, findings: [] };
  }

  const beats = history.beats;
  if (beats.length === 0) {
    // Either the first ever scheduled run, or a silence long enough that the
    // previous heartbeat fell outside the lookback. Worth stating in the
    // summary, but not something this can characterize.
    return { configured: true, firstRun: true, lastSeen: null, findings: [] };
  }

  const lastSeen = beats[0].at;
  const ageMinutes = Math.floor((now.getTime() - lastSeen.getTime()) / 60_000);
  const baseline = heartbeatGapTolerance(heartbeatIntervals(beats));

  if (baseline === null) {
    return {
      configured: true,
      lastSeen: lastSeen.toISOString(),
      ageMinutes,
      baselineKnown: false,
      findings: [],
    };
  }

  const findings = [];
  if (ageMinutes > baseline.toleranceMinutes) {
    findings.push({
      severity: "warn",
      area: "watchdog",
      title: "This health check stopped running and has now resumed",
      detail:
        `The previous scheduled heartbeat was ${String(ageMinutes)} minutes ago. ` +
        `Recent scheduled runs have been landing about ${String(baseline.baselineMinutes)} ` +
        `minutes apart (median of ${String(baseline.samples)} intervals), so anything past ` +
        `${String(baseline.toleranceMinutes)} minutes is longer than this schedule's own worst ` +
        "behavior rather than more of it. The fleet was unmonitored for that period; " +
        "nothing here can say what happened during it. Scheduled workflows are " +
        "disabled automatically after a stretch of repository inactivity, which is " +
        "the usual cause.",
    });
  }

  return {
    configured: true,
    lastSeen: lastSeen.toISOString(),
    ageMinutes,
    baselineKnown: true,
    ...baseline,
    findings,
  };
}

/**
 * Detect a fleet flipping between healthy and unhealthy across runs.
 *
 * Complements the within-run sampling in `probes.mjs`: that catches a surface
 * failing part of the traffic in one moment, this catches one that is cleanly
 * up and cleanly down in alternation across consecutive runs.
 *
 * Pure, for the same reason as the gap check above.
 */
export function checkFleetOscillation({ history }) {
  if (!history.configured || history.unknown) return { findings: [] };

  const window = history.beats.slice(0, OSCILLATION_RUN_WINDOW);
  const verdicts = window.map((beat) => beat.healthy);
  const readable = verdicts.filter((v) => readVerdict(v) !== null);

  // Three flips need four runs to sit between. Below that the honest answer
  // is "not enough history yet", which is not the same as "not flapping".
  if (readable.length <= OSCILLATION_THRESHOLD) {
    return { flips: 0, runs: readable.length, findings: [] };
  }

  const flips = countOscillations(verdicts);
  const spanMinutes = Math.round(
    (window[0].at.getTime() - window[window.length - 1].at.getTime()) / 60_000,
  );

  const findings = [];
  if (flips >= OSCILLATION_THRESHOLD) {
    findings.push({
      severity: "red",
      area: "flapping",
      title: "The fleet is flipping between healthy and unhealthy",
      detail:
        `${String(flips)} transitions across the last ${String(readable.length)} scheduled runs, ` +
        `spanning ${String(spanMinutes)} minutes. Individual runs are each reaching a ` +
        "consistent verdict, so nothing is wrong with any single check — the " +
        "instability only shows up in the sequence. Something is recovering and " +
        "failing again rather than staying fixed.",
    });
  }

  return { flips, runs: readable.length, spanMinutes, findings };
}

/**
 * Decide what a project-identity comparison means.
 *
 * Pure, so the branch that must *not* produce a finding is pinned by a test:
 * an assertion that cannot be run is reported in the summary and nowhere
 * else. Turning it into a standing warning would recreate the always-present
 * warning this file exists to have removed.
 */
export function evaluateProjectMatch({
  ingestionKey,
  projectToken,
  projectId,
}) {
  if (!ingestionKey || !projectId) {
    return { note: "not checked (not configured)", findings: [] };
  }
  if (!projectToken) {
    // Reading project details needs a permission the query path does not, so
    // a personal key scoped only for querying cannot confirm this.
    return {
      note: "not confirmed (project details unavailable)",
      findings: [],
    };
  }
  if (ingestionKey !== projectToken) {
    return {
      note: "MISMATCH",
      findings: [
        {
          severity: "red",
          area: "watchdog",
          title:
            "The heartbeat is written to a different project than it is read from",
          detail:
            "The configured ingestion key does not belong to the project these " +
            `checks read back from (${String(projectId)}). Nothing else here would say ` +
            "so: both readers find no rows, both return no findings, and the run " +
            "looks healthy. Point the ingestion key and the project id at the same " +
            "project, and treat every gap and flapping verdict since they diverged " +
            "as unmeasured rather than clean.",
        },
      ],
    };
  }
  return { note: `confirmed (project ${String(projectId)})`, findings: [] };
}

/**
 * Assert that the project the heartbeat is written to is the project the
 * checks read back from.
 *
 * The write is configured by an ingestion key and the read by a project id,
 * with nothing tying the two together. If they drift apart, every reader in
 * this file returns no rows and therefore no findings, silently and
 * permanently, in a way indistinguishable from a healthy fleet. Neither
 * token is ever put in a finding: the mismatch is the news, not the values.
 */
export async function checkHeartbeatProjectMatch({ env }) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const host = env.POSTHOG_HOST;
  const projectId = env.POSTHOG_PROJECT_ID_PROD;
  const ingestionKey = env.POSTHOG_INGESTION_KEY;

  if (!apiKey || !host || !projectId || !ingestionKey) {
    return evaluateProjectMatch({
      ingestionKey,
      projectToken: null,
      projectId,
    });
  }

  let projectToken = null;
  try {
    const response = await fetch(`${host}/api/projects/${String(projectId)}/`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const payload = await response.json();
      projectToken =
        typeof payload.api_token === "string" ? payload.api_token : null;
    }
  } catch {
    projectToken = null;
  }

  return evaluateProjectMatch({ ingestionKey, projectToken, projectId });
}
