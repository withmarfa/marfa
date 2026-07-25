/**
 * Watching the watcher.
 *
 * Every check in this workflow answers "is the fleet healthy?". None of them
 * answers "is anything still asking?" — and a monitor that silently stops is
 * indistinguishable from a fleet that is fine. Both produce no alerts.
 *
 * Two mechanisms close that gap, because no single one can:
 *
 *   1. **Emit** a heartbeat event on every run, red or green. Its *absence*
 *      in the telemetry backend is the signal that the watcher stopped, and
 *      an absence can be alerted on from outside this repository entirely
 *      (see the workflow header for how to wire that).
 *   2. **Read** the previous heartbeat at the start of each run. This cannot
 *      detect a watcher that never comes back, but it does detect one that
 *      stopped and resumed — the common case, since scheduled workflows are
 *      disabled after a period of repository inactivity and silently resume
 *      when someone pushes. That gap would otherwise leave no trace.
 */

const HEARTBEAT_EVENT = "marfa_watchdog_heartbeat";

/**
 * How stale the previous heartbeat may be before the gap is reported.
 *
 * Deliberately several times the schedule interval. Scheduled runs are queued
 * on shared infrastructure and are routinely delayed by several minutes under
 * load, so a tight bound here would report a gap that never happened.
 */
const MAX_HEARTBEAT_AGE_MINUTES = 30;

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
 * Three flips is two full cycles: enough that a single recovery or a single
 * new failure does not register, since those are one flip each and are
 * already reported by the alert issue opening or closing.
 */
const HISTORY_WINDOW_MINUTES = 90;
const OSCILLATION_THRESHOLD = 3;

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
 * Count healthy/unhealthy transitions in a sequence of run verdicts.
 *
 * Exported and pure: the ordering and the definition of a "flip" are the part
 * worth reasoning about without a network. Non-boolean entries are ignored
 * rather than guessed at, so a malformed record cannot manufacture a flip.
 */
export function countOscillations(verdicts) {
  const clean = verdicts.filter((v) => typeof v === "boolean");
  let flips = 0;
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i] !== clean[i - 1]) flips += 1;
  }
  return flips;
}

/**
 * Detect a fleet flipping between healthy and unhealthy across runs.
 *
 * Complements the within-run sampling in `probes.mjs`: that catches a surface
 * failing part of the traffic in one moment, this catches one that is cleanly
 * up and cleanly down in alternation over an hour.
 */
export async function checkFleetOscillation({ env }) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const host = env.POSTHOG_HOST;
  const projectId = env.POSTHOG_PROJECT_ID_PROD;
  if (!apiKey || !host || !projectId) return { findings: [] };

  const query =
    `SELECT properties.healthy FROM events WHERE event = '${HEARTBEAT_EVENT}' ` +
    `AND timestamp >= now() - INTERVAL ${String(HISTORY_WINDOW_MINUTES)} MINUTE ` +
    "ORDER BY timestamp DESC LIMIT 32";

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
    if (!response.ok) return { findings: [] };

    const payload = await response.json();
    const verdicts = (payload.results ?? []).map((row) => row[0]);
    const flips = countOscillations(verdicts);

    if (flips >= OSCILLATION_THRESHOLD) {
      return {
        flips,
        runs: verdicts.length,
        findings: [
          {
            severity: "red",
            area: "flapping",
            title: "The fleet is flipping between healthy and unhealthy",
            detail:
              `${String(flips)} transitions across the last ${String(verdicts.length)} runs ` +
              `(${String(HISTORY_WINDOW_MINUTES)} minutes). Individual runs are each ` +
              "reaching a consistent verdict, so nothing is wrong with any single " +
              "check — the instability only shows up in the sequence. Something is " +
              "recovering and failing again rather than staying fixed.",
          },
        ],
      };
    }

    return { flips, runs: verdicts.length, findings: [] };
  } catch {
    return { findings: [] };
  }
}

/**
 * Read the most recent heartbeat and report whether the watcher had a gap.
 */
export async function checkHeartbeatGap({ env, now }) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const host = env.POSTHOG_HOST;
  const projectId = env.POSTHOG_PROJECT_ID_PROD;
  if (!apiKey || !host || !projectId) {
    return { configured: false, findings: [] };
  }

  // The row count is selected alongside the timestamp deliberately. An
  // aggregate over zero matching rows does not come back empty — it comes
  // back as the column type's zero value, which parses as a valid date in
  // 1970 and would be reported as a gap of several decades. The count is the
  // only honest way to tell "no heartbeat recorded" from "a very old one".
  const query =
    `SELECT count() AS beats, max(timestamp) AS last_seen FROM events ` +
    `WHERE event = '${HEARTBEAT_EVENT}' AND timestamp >= now() - INTERVAL 7 DAY`;

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
    if (!response.ok) return { configured: true, findings: [], unknown: true };

    const payload = await response.json();
    const [beats, raw] = payload.results?.[0] ?? [0, null];

    if (!Number(beats) || !raw) {
      // No heartbeat in a week: either the first ever run, or the watcher has
      // been silent long enough that the record aged out. Worth saying out
      // loud in the summary, but not a fleet problem in itself.
      return { configured: true, findings: [], lastSeen: null, firstRun: true };
    }

    const lastSeen = new Date(raw);
    const ageMinutes = Math.floor(
      (now.getTime() - lastSeen.getTime()) / 60_000,
    );

    if (ageMinutes > MAX_HEARTBEAT_AGE_MINUTES) {
      return {
        configured: true,
        lastSeen: lastSeen.toISOString(),
        ageMinutes,
        findings: [
          {
            severity: "warn",
            area: "watchdog",
            title: "This health check stopped running and has now resumed",
            detail:
              `The previous heartbeat was ${String(ageMinutes)} minutes ago, past the ` +
              `${String(MAX_HEARTBEAT_AGE_MINUTES)}-minute tolerance. The fleet was ` +
              "unmonitored for that period; nothing here can say what happened " +
              "during it. Scheduled workflows are disabled automatically after a " +
              "stretch of repository inactivity, which is the usual cause.",
          },
        ],
      };
    }

    return {
      configured: true,
      lastSeen: lastSeen.toISOString(),
      ageMinutes,
      findings: [],
    };
  } catch {
    return { configured: true, findings: [], unknown: true };
  }
}
