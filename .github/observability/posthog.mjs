/**
 * Telemetry-derived checks: error rate and crash-loop detection.
 *
 * Telemetry answers the questions an HTTP probe cannot. A probe says "the
 * public endpoint returned 200"; it says nothing about a service that is
 * restarting every two seconds behind a load balancer, or about an error
 * class that never reaches a status code the probe looks at.
 *
 * Crucially this is also the only channel that sees deployments with no
 * public ingress. Their logs still ship to the same telemetry backend, so a
 * service that is invisible to `probes.mjs` is still visible here. The
 * crash-loop check below is the specific control for a service restarting in
 * a tight loop while emitting one startup record per cycle — a signal that
 * exists in the data whether or not anything is reading it.
 */

/**
 * Two windows, one query per project. Log volume is low and the query API is
 * rate-limited per hour, so error counts and boot counts are gathered with a
 * single conditional aggregation rather than two round trips.
 */
const WINDOW_MINUTES = 15;

/**
 * Error-severity records per service within the window before it is called
 * red. Steady-state volume across the fleet is single-digit errors per *day*,
 * so a window carrying this many is a genuine change in behavior rather than
 * ordinary noise.
 */
const ERROR_COUNT_THRESHOLD = 10;

/**
 * Startup records per service within the window before it is called a crash
 * loop.
 *
 * The floor cannot be 1. Hosted containers scale to zero and log a startup
 * line on every wake, which is normal and happens a few times an hour under
 * bursty traffic. A real crash loop is orders of magnitude faster — a service
 * restarting every few seconds produces hundreds of startup records an hour.
 * This threshold sits far above cold-start churn and far below a genuine
 * loop, so it separates the two without needing to know which is which in
 * advance.
 */
const BOOT_COUNT_THRESHOLD = 10;

/**
 * Startup log lines carry the listen port, which differs per deployment, so
 * the match is a prefix rather than an equality.
 */
const BOOT_MESSAGE_PREFIX = "Marfa server listening on port";

function buildTelemetryQuery() {
  // `level` is the normalized severity column. `message` aliases the log body.
  return [
    "SELECT service_name,",
    "  countIf(level = 'error') AS error_count,",
    `  countIf(message ILIKE '${BOOT_MESSAGE_PREFIX}%') AS boot_count,`,
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
 * Check one telemetry project. A project maps to an environment; a service
 * within it maps to a deployment.
 */
async function checkProject({ host, projectId, apiKey, label }) {
  const findings = [];
  const services = [];

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
    // means these checks are not running, which is the failure mode this
    // whole workflow exists to prevent going unnoticed.
    findings.push({
      severity: "red",
      area: "telemetry",
      title: `Telemetry query failed for ${label}`,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { findings, services, ok: false };
  }

  for (const row of rows) {
    const [serviceName, errorCount, bootCount, totalCount] = row;
    const service = {
      project: label,
      service: String(serviceName),
      errors: Number(errorCount),
      boots: Number(bootCount),
      total: Number(totalCount),
    };
    services.push(service);

    if (service.errors >= ERROR_COUNT_THRESHOLD) {
      findings.push({
        severity: "red",
        area: "error-rate",
        title: `Elevated error rate: ${service.service} (${label})`,
        detail:
          `${String(service.errors)} error-severity records in the last ` +
          `${String(WINDOW_MINUTES)} minutes (threshold ${String(ERROR_COUNT_THRESHOLD)}).`,
      });
    }

    if (service.boots >= BOOT_COUNT_THRESHOLD) {
      findings.push({
        severity: "red",
        area: "crash-loop",
        title: `Crash loop suspected: ${service.service} (${label})`,
        detail:
          `${String(service.boots)} startup records in the last ` +
          `${String(WINDOW_MINUTES)} minutes (threshold ${String(BOOT_COUNT_THRESHOLD)}). ` +
          "A service restarting this often is not serving traffic reliably " +
          "even if its public endpoint answers.",
      });
    }
  }

  return { findings, services, ok: true };
}

/**
 * Run the telemetry checks across every configured project.
 *
 * Returns `configured: false` rather than throwing when credentials are
 * absent, so a fork or a self-hosted deployment without telemetry wiring gets
 * a clear "not checked" line instead of a spurious alert.
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
