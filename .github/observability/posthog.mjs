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
 * Error-severity records per service within the window before it is called
 * red. Steady-state volume across the fleet is single-digit errors per *day*,
 * so a window carrying this many is a real change in behavior.
 */
const ERROR_COUNT_THRESHOLD = 10;

/**
 * Absolute startup-record threshold: the fast trip for a catastrophic loop.
 *
 * The floor cannot be 1, and it cannot be low. Hosted containers scale to
 * zero and log a startup line on every wake, so a service under intermittent
 * traffic legitimately cycles every two to three minutes — six or seven
 * startups in a fifteen-minute window with nothing wrong at all. This sits
 * above that ceiling. A service restarting every few seconds produces
 * hundreds an hour and trips it immediately.
 */
const BOOT_COUNT_THRESHOLD = 10;

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
 * nothing stopped cleanly. The threshold leaves room for a couple of
 * unmatched events at the window's edges, where a shutdown can fall just
 * outside a window whose startup falls just inside.
 */
const UNCLEAN_RESTART_THRESHOLD = 3;

/**
 * Startup lines carry the listen port, which differs per deployment, so the
 * match is a prefix. The shutdown line is the server's own orderly-stop log.
 */
const BOOT_MESSAGE_PREFIX = "Marfa server listening on port";
const SHUTDOWN_MESSAGE_PREFIX = "Shutting down";

function buildTelemetryQuery() {
  // `level` is the normalized severity column; `message` aliases the log body.
  return [
    "SELECT service_name,",
    "  countIf(level = 'error') AS error_count,",
    `  countIf(message ILIKE '${BOOT_MESSAGE_PREFIX}%') AS boot_count,`,
    `  countIf(message ILIKE '${SHUTDOWN_MESSAGE_PREFIX}%') AS shutdown_count,`,
    "  count() AS total_count",
    "FROM logs",
    `WHERE timestamp >= now() - INTERVAL ${String(WINDOW_MINUTES)} MINUTE`,
    "GROUP BY service_name",
    "ORDER BY total_count DESC",
  ].join(" ");
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

  if (service.boots >= BOOT_COUNT_THRESHOLD) {
    findings.push({
      severity: "red",
      area: "crash-loop",
      title: `Restart loop: ${service.service} (${service.project})`,
      detail:
        `${String(service.boots)} startups in the last ${String(WINDOW_MINUTES)} ` +
        `minutes (threshold ${String(BOOT_COUNT_THRESHOLD)}). A service restarting ` +
        "this often is not serving traffic reliably even if its endpoint answers.",
    });
  } else if (service.uncleanRestarts >= UNCLEAN_RESTART_THRESHOLD) {
    // Below the absolute threshold but restarting without shutting down: the
    // slow crash loop a raw startup count cannot tell apart from a container
    // waking on demand.
    findings.push({
      severity: "red",
      area: "crash-loop",
      title: `Unclean restarts: ${service.service} (${service.project})`,
      detail:
        `${String(service.boots)} startups but only ${String(service.shutdowns)} clean ` +
        `shutdowns in the last ${String(WINDOW_MINUTES)} minutes, leaving ` +
        `${String(service.uncleanRestarts)} restarts that nothing stopped cleanly ` +
        `(threshold ${String(UNCLEAN_RESTART_THRESHOLD)}). Scale-to-zero cycling ` +
        "produces matched pairs; a process that dies does not log a shutdown.",
    });
  }

  return findings;
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

  const services = rows.map((row) => {
    const [serviceName, errorCount, bootCount, shutdownCount, totalCount] = row;
    const boots = Number(bootCount);
    const shutdowns = Number(shutdownCount);
    return {
      project: label,
      service: String(serviceName),
      errors: Number(errorCount),
      boots,
      shutdowns,
      uncleanRestarts: Math.max(0, boots - shutdowns),
      total: Number(totalCount),
    };
  });

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
