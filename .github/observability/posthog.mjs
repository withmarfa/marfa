/**
 * Telemetry-derived checks: error rate and restart-loop detection.
 *
 * Telemetry answers questions an HTTP probe cannot — an error class that
 * never reaches a status code the probe looks at, or a service restarting
 * behind a load balancer that still answers every request.
 *
 * It also reaches deployments with no public ingress, whose logs ship to the
 * same backend even though nothing can probe them.
 *
 * **What it cannot do, and why the probes are not redundant.** A service that
 * fails to start emits nothing. Every telemetry-derived rule goes quiet, in a
 * way that is indistinguishable from a healthy idle period. That is exactly
 * the shape of a real outage seen here: the edge returned "failed to start
 * container" to every request while these queries returned a calm nothing.
 * Absence of telemetry is never evidence of health, which is why these checks
 * are paired with external probing rather than trusted alone.
 */

/**
 * One window, one query per project. Log volume is low and the query API is
 * rate-limited per hour, so every count is gathered in a single conditional
 * aggregation rather than several round trips.
 */
const WINDOW_MINUTES = 15;

/**
 * How far back the shutdown-line delivery rate below is judged over.
 *
 * Deliberately much wider than the alerting window. A fifteen-minute sample
 * of "did this service log any clean stop" is mostly noise at the rate these
 * containers cycle, and — more importantly — a genuine crash loop inside the
 * window would suppress its own detection if the premise were judged from the
 * same rows as the symptom.
 */
const DELIVERY_BASELINE_HOURS = 24;

/**
 * Error-severity records per service within the window before it is called
 * red. Steady-state volume across the fleet is single-digit errors per *day*,
 * so a window carrying this many is a real change in behavior.
 */
const ERROR_COUNT_THRESHOLD = 10;

/**
 * The exact message the server logs every refused authorization under.
 *
 * Duplicated from `AUTHORIZE_REFUSED_MESSAGE` in
 * `packages/server/src/auth/oauth-provider.ts` because this directory runs
 * standalone on a CI runner with no install step, so it cannot import from
 * the workspace. `oauth-authorize-observability.test.ts` reads this file and
 * asserts the two strings agree, so the copy cannot drift silently — which
 * matters more here than usual, since a mismatch produces a counter that is
 * always zero and therefore an alert that looks healthy while blind.
 */
export const AUTHORIZE_REFUSED_MESSAGE = "oauth authorize refused the request";

/**
 * Refused authorizations per service within the window before it is called
 * red.
 *
 * **Why this is not folded into the error count.** A client asking for a
 * scope this server will not grant is not a server error, and logging it at
 * `error` would put a third party's misconfiguration into the same counter as
 * a crash. But it is the shape of the fault that took hosted sign-in down for
 * days: every authorize 302'd with `invalid_scope`, the HTTP probes stayed
 * green because an SPA shell renders perfectly well when sign-in is broken,
 * and nothing counted the refusals. A separate counter is what makes that
 * visible without corrupting the meaning of the other one.
 *
 * **The threshold is provisional and says so.** Every other number in this
 * file is derived from measured production behavior; this signal did not
 * exist until the outage above was fixed, so there is no history to measure.
 * Five is chosen as low enough that a total outage trips it within one window
 * and high enough that an occasional misconfigured third-party client does
 * not. Revisit against real volume once there is a month of it — and revisit
 * it deliberately, rather than raising it the first time it fires.
 *
 * Only `warn` records count. The `info` ones are ordinary flow control — a
 * person declining consent, a silent-renewal probe learning it needs
 * interaction — and folding those in would make the counter track traffic
 * rather than trouble.
 */
export const AUTHORIZE_REFUSAL_THRESHOLD = 5;

/**
 * What healthy scale-to-zero actually looks like. One measurement, one place.
 *
 * Every threshold below is derived from this object, and the tests assert
 * against it rather than restating it, because two independently written
 * "measured from production" numbers is how this file previously came to
 * carry two that disagreed by a factor of fifty.
 *
 * Method: `countIf(message ILIKE 'Marfa server listening on port%')` against
 * `countIf(message ILIKE 'Shutting down%')` on the `logs` table, grouped by
 * `toStartOfFifteenMinutes(timestamp)` — the same window the alerting uses —
 * over the seven days to the date below, in both telemetry projects, across a
 * period with no known incident.
 *
 *   |                            | production | staging |
 *   |----------------------------|------------|---------|
 *   | startups                   | 60         | 217     |
 *   | clean shutdowns            | 8          | 6       |
 *   | busiest window (startups)  | 2          | 3       |
 *   | busiest window (unpaired)  | 1          | 3       |
 *
 * Two things follow, and they pull in opposite directions.
 *
 * **Startup volume is far lower than this file used to claim.** Nine startups
 * a day in production, not the six or seven per fifteen-minute window that an
 * earlier comment asserted — an error of roughly seventy times, and every
 * threshold here was justified by it.
 *
 * **Clean shutdowns are almost never recorded.** Eight of sixty in
 * production, six of two hundred and seventeen in staging. The shutdown line
 * is emitted by a process that is about to exit, so it has to survive a race
 * the startup line never runs. Until that race is fixed the excess of
 * startups over shutdowns measures lost log lines, not restarts, and it
 * already reaches the unpaired threshold twice a week in staging on
 * infrastructure that was serving fine. That is what `deliveryRateFloor`
 * below exists to stop being reported as a crash loop.
 */
export const MEASURED_SCALE_TO_ZERO = {
  measuredOn: "2026-07-29",
  windowDays: 7,
  environments: "production and staging",
  peakStartupsPerWindow: 3,
  peakUnpairedPerWindow: 3,
  shutdownsRecorded: 14,
  startupsRecorded: 277,
};

/**
 * Absolute startup-record threshold: the fast trip for a catastrophic loop.
 *
 * This fires on rate alone, whatever the pairing says, so it has to sit where
 * even perfectly matched cycling is pathological rather than merely busy. Ten
 * times the busiest window ever measured is a restart every thirty seconds
 * sustained across the window; nothing healthy does that, matched or not.
 *
 * It used to sit at ten, which the pairing check then could not soften,
 * because the two rules were an if/else and the absolute one came first. Ten
 * matched startups and ten matched shutdowns — textbook scale-to-zero by this
 * file's own definition — was reported as a restart loop, discarding the
 * pairing comparison in exactly the case it was added to judge.
 */
const PATHOLOGICAL_BOOT_THRESHOLD =
  MEASURED_SCALE_TO_ZERO.peakStartupsPerWindow * 10;

/**
 * Unclean-restart threshold: the slow-loop trip the absolute one misses.
 *
 * Startup count alone cannot separate "scale-to-zero cycling" from "crashing
 * and restarting". Measured against a real production incident, both sit at
 * one or two startups per window — well under any threshold that does not
 * also fire on healthy idling.
 *
 * What separates them is how the process *ended*. An orderly stop logs a
 * shutdown line before the next startup, so scale-to-zero cycling produces
 * startups and shutdowns in matched pairs. A process that dies does not get
 * to log anything, so its startups are unpaired.
 *
 * The excess of startups over shutdowns is therefore the number of restarts
 * nothing stopped cleanly. The threshold stays tight — three — because the
 * incident it exists to catch is small: a couple of unpaired startups per
 * window is the whole signal. Loosening it to clear the measured noise would
 * have raised it above the incident.
 */
const UNCLEAN_RESTART_THRESHOLD = 3;

/**
 * The share of stops that must be recorded before an *un*recorded stop means
 * anything.
 *
 * The unpaired count is a difference between two log lines, and it is only a
 * measure of restarts if both lines are equally likely to arrive. They are
 * not: see the measurement above. A service whose clean stops are almost
 * never recorded produces unpaired startups continuously while behaving
 * perfectly, and a threshold cannot tell those apart from the real thing at
 * any value — set it above the noise and it sits above the incident too.
 *
 * So the premise is checked rather than assumed. Over a day-long baseline, if
 * a service records a clean stop for at least half its startups, its shutdown
 * line is arriving and an excess is worth reporting. Below that the pairing
 * comparison carries no information about this service, and the run summary
 * says so instead of raising an alert about it — absence of a log line is not
 * evidence of an unclean stop, the same discipline this file already applies
 * to absence of telemetry.
 *
 * A genuine crash loop is not suppressed by its own crashing: the baseline is
 * a day wide, so a service that was stopping cleanly this morning still has a
 * healthy delivery rate when it starts dying this afternoon.
 */
const SHUTDOWN_DELIVERY_FLOOR = 0.5;

/**
 * Startup lines carry the listen port, which differs per deployment, so the
 * match is a prefix. The shutdown line is the server's own orderly-stop log.
 */
const BOOT_MESSAGE_PREFIX = "Marfa server listening on port";
const SHUTDOWN_MESSAGE_PREFIX = "Shutting down";

export function buildTelemetryQuery() {
  // `level` is the normalized severity column; `message` aliases the log body.
  //
  // Two spans, one scan. The outer bound is the day-wide delivery baseline;
  // the alerting counts narrow to the recent window inside the aggregates.
  // Splitting these into two queries would double the round trips against an
  // API that is rate-limited per hour, for rows that are already read.
  const recent = `timestamp >= now() - INTERVAL ${String(WINDOW_MINUTES)} MINUTE`;
  return [
    "SELECT service_name,",
    `  countIf(level = 'error' AND ${recent}) AS error_count,`,
    `  countIf(message = '${AUTHORIZE_REFUSED_MESSAGE}' AND level = 'warn' AND ${recent}) AS authorize_refusal_count,`,
    `  countIf(message ILIKE '${BOOT_MESSAGE_PREFIX}%' AND ${recent}) AS boot_count,`,
    `  countIf(message ILIKE '${SHUTDOWN_MESSAGE_PREFIX}%' AND ${recent}) AS shutdown_count,`,
    `  countIf(${recent}) AS total_count,`,
    `  countIf(message ILIKE '${BOOT_MESSAGE_PREFIX}%') AS baseline_boot_count,`,
    `  countIf(message ILIKE '${SHUTDOWN_MESSAGE_PREFIX}%') AS baseline_shutdown_count`,
    "FROM logs",
    `WHERE timestamp >= now() - INTERVAL ${String(DELIVERY_BASELINE_HOURS)} HOUR`,
    "GROUP BY service_name",
    "ORDER BY total_count DESC",
  ].join(" ");
}

/**
 * Turn query rows into service records. Pure and exported: the subtraction
 * that defines an unpaired restart, and the delivery premise that decides
 * whether the subtraction means anything, both live here rather than inline
 * in the network path where nothing can reach them.
 */
export function servicesFromRows(rows, label) {
  return rows.map((row) => {
    const [
      serviceName,
      errorCount,
      authorizeRefusalCount,
      bootCount,
      shutdownCount,
      totalCount,
      baselineBootCount,
      baselineShutdownCount,
    ] = row;
    const boots = Number(bootCount);
    const shutdowns = Number(shutdownCount);
    const baselineBoots = Number(baselineBootCount);
    const baselineShutdowns = Number(baselineShutdownCount);
    // No startups over the baseline means nothing to pair against, which is
    // not the same as a service whose stops go unrecorded. Treat it as
    // observable so a service that only cycles inside the alerting window is
    // still judged; the unpaired threshold is what keeps that quiet.
    const deliveryRate =
      baselineBoots === 0 ? 1 : baselineShutdowns / baselineBoots;
    return {
      project: label,
      service: String(serviceName),
      errors: Number(errorCount),
      authorizeRefusals: Number(authorizeRefusalCount),
      boots,
      shutdowns,
      uncleanRestarts: Math.max(0, boots - shutdowns),
      pairingObservable: deliveryRate >= SHUTDOWN_DELIVERY_FLOOR,
      deliveryRate,
      total: Number(totalCount),
    };
  });
}

/**
 * Run a HogQL query against one project. Returns rows as arrays, in the
 * column order the query declares.
 */
async function runQuery({ host, projectId, apiKey, query }) {
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

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `query API returned ${String(response.status)}: ${detail.slice(0, 300)}`,
    );
  }

  const payload = await response.json();
  return Array.isArray(payload.results) ? payload.results : [];
}

/**
 * Turn one service's counts into findings. Pure, so the thresholds can be
 * reasoned about without a network.
 */
export function evaluateService(service) {
  const findings = [];

  if (service.errors >= ERROR_COUNT_THRESHOLD) {
    findings.push({
      severity: "red",
      area: "error-rate",
      title: `Elevated error rate: ${service.service} (${service.project})`,
      detail:
        `${String(service.errors)} error-severity records in the last ` +
        `${String(WINDOW_MINUTES)} minutes (threshold ${String(ERROR_COUNT_THRESHOLD)}).`,
    });
  }

  if (service.authorizeRefusals >= AUTHORIZE_REFUSAL_THRESHOLD) {
    findings.push({
      severity: "red",
      area: "authorize-refusals",
      title: `Sign-in refusals: ${service.service} (${service.project})`,
      detail:
        `${String(service.authorizeRefusals)} authorization requests refused in ` +
        `the last ${String(WINDOW_MINUTES)} minutes ` +
        `(threshold ${String(AUTHORIZE_REFUSAL_THRESHOLD)}). ` +
        "Each one is a client that could not complete sign-in. Query the " +
        "`error_code` attribute on those records for the reason.",
    });
  }

  if (service.boots >= PATHOLOGICAL_BOOT_THRESHOLD) {
    findings.push({
      severity: "red",
      area: "crash-loop",
      title: `Restart loop: ${service.service} (${service.project})`,
      detail:
        `${String(service.boots)} startups in the last ${String(WINDOW_MINUTES)} ` +
        `minutes (threshold ${String(PATHOLOGICAL_BOOT_THRESHOLD)}, against a busiest ` +
        `measured window of ${String(MEASURED_SCALE_TO_ZERO.peakStartupsPerWindow)}). ` +
        "A service cycling this fast is not serving traffic reliably even if " +
        "its endpoint answers, and no amount of clean pairing makes that rate " +
        "normal — which is why this one rule ignores the pairing.",
    });
  } else if (
    service.pairingObservable !== false &&
    service.uncleanRestarts >= UNCLEAN_RESTART_THRESHOLD
  ) {
    // Below the absolute threshold but restarting without shutting down: the
    // slow crash loop a raw startup count cannot tell apart from a container
    // waking on demand. Only meaningful where clean stops are recorded at all,
    // which is what `pairingObservable` carries.
    findings.push({
      severity: "red",
      area: "crash-loop",
      title: `Unclean restarts: ${service.service} (${service.project})`,
      detail:
        `${String(service.boots)} startups but only ${String(service.shutdowns)} clean ` +
        `shutdowns in the last ${String(WINDOW_MINUTES)} minutes, leaving ` +
        `${String(service.uncleanRestarts)} restarts that nothing stopped cleanly ` +
        `(threshold ${String(UNCLEAN_RESTART_THRESHOLD)}). Scale-to-zero cycling ` +
        "produces matched pairs; a process that dies does not log a shutdown. " +
        "This service does record its clean stops the rest of the time, so the " +
        "missing ones are the news.",
    });
  }

  return findings;
}

/**
 * Services whose pairing comparison could not be run. Reported in the run
 * summary rather than as a finding: a standing red on every service in the
 * fleet would be the always-present alert this workflow exists to remove, and
 * the honest statement is that a check did not run, not that something broke.
 */
export function unobservablePairing(services) {
  return services
    .filter((s) => s.pairingObservable === false)
    .map(
      (s) =>
        `${s.service} (${s.project}) — ${String(Math.round(s.deliveryRate * 100))}% of ` +
        "startups have a recorded clean stop",
    );
}

/** Check one telemetry project. A project maps to an environment. */
async function checkProject({ host, projectId, apiKey, label }) {
  let rows;
  try {
    rows = await runQuery({
      host,
      projectId,
      apiKey,
      query: buildTelemetryQuery(),
    });
  } catch (error) {
    // A telemetry backend that cannot be queried is itself a finding: it
    // means these checks are not running, which is the failure this workflow
    // exists to stop going unnoticed.
    return {
      services: [],
      findings: [
        {
          severity: "red",
          area: "telemetry",
          title: `Telemetry query failed for ${label}`,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const services = servicesFromRows(rows, label);

  return { services, findings: services.flatMap(evaluateService) };
}

/**
 * Run the telemetry checks across every configured project.
 *
 * Returns `configured: false` rather than throwing when credentials are
 * absent, so a fork or a deployment without telemetry wiring gets a clear
 * "not checked" line instead of a spurious alert.
 */
export async function checkTelemetry(env) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const host = env.POSTHOG_HOST;

  const projects = [
    { projectId: env.POSTHOG_PROJECT_ID_PROD, label: "production" },
    { projectId: env.POSTHOG_PROJECT_ID_STAGING, label: "staging" },
  ].filter((p) => p.projectId);

  if (!apiKey || !host || projects.length === 0) {
    return {
      configured: false,
      findings: [],
      services: [],
      windowMinutes: WINDOW_MINUTES,
    };
  }

  const results = await Promise.all(
    projects.map((p) =>
      checkProject({ host, projectId: p.projectId, apiKey, label: p.label }),
    ),
  );

  return {
    configured: true,
    windowMinutes: WINDOW_MINUTES,
    findings: results.flatMap((r) => r.findings),
    services: results.flatMap((r) => r.services),
  };
}
