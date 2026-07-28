/**
 * Liveness probes against every publicly reachable surface.
 */

/**
 * Hosted containers scale to zero, so the first request after an idle period
 * pays a cold start of roughly eleven to fifteen seconds. That cost is a
 * deliberate trade, which makes it a normal condition rather than an
 * incident — and it means a probe timeout tuned for a warm service would
 * alert on nearly every quiet period.
 *
 * The timeout is therefore set well clear of a worst-case wake, and a failed
 * attempt is retried before anything is called down. Two independent slow
 * responses are evidence; one is a cold start.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 3_000;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function attemptProbe(surface) {
  const startedAt = Date.now();
  const response = await fetch(surface.url, {
    method: "GET",
    redirect: "follow",
    headers: {
      // Cache-bust so a CDN edge cannot answer on behalf of a dead origin.
      "Cache-Control": "no-cache",
      "User-Agent": "marfa-observability-watchdog",
    },
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });

  const durationMs = Date.now() - startedAt;
  const body = await response.text();
  return { status: response.status, durationMs, body };
}

/**
 * Inspect a `/health` payload for components reporting anything other than
 * ok. A 200 with a downed database is still an outage; the status code alone
 * is not the whole signal.
 */
function inspectHealthPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { parsed: false, degraded: ["health payload was not valid JSON"] };
  }

  const degraded = [];
  if (payload.status && payload.status !== "ok") {
    degraded.push(`overall status is "${String(payload.status)}"`);
  }

  for (const [name, component] of Object.entries(payload.components ?? {})) {
    if (component?.status && component.status !== "ok") {
      const reason = component.error ? `: ${String(component.error)}` : "";
      degraded.push(
        `component "${name}" is "${String(component.status)}"${reason}`,
      );
    }
  }

  return {
    parsed: true,
    degraded,
    sha: payload.version?.sha ? String(payload.version.sha) : null,
    authMode: payload.auth_mode ? String(payload.auth_mode) : null,
  };
}

async function probeSurface(surface) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await attemptProbe(surface);

      if (result.status !== 200) {
        lastError = `HTTP ${String(result.status)}`;
        // Retry rather than alerting immediately: a container that is still
        // waking can answer with a transient gateway error.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return {
          surface,
          ok: false,
          attempts: attempt,
          detail: `returned ${lastError} after ${String(attempt)} attempts`,
          durationMs: result.durationMs,
          sha: null,
        };
      }

      if (surface.kind !== "server") {
        return {
          surface,
          ok: true,
          attempts: attempt,
          durationMs: result.durationMs,
          sha: null,
        };
      }

      const health = inspectHealthPayload(result.body);
      if (health.degraded.length > 0) {
        return {
          surface,
          ok: false,
          attempts: attempt,
          detail: health.degraded.join("; "),
          durationMs: result.durationMs,
          sha: health.sha ?? null,
        };
      }

      return {
        surface,
        ok: true,
        attempts: attempt,
        durationMs: result.durationMs,
        sha: health.sha ?? null,
        authMode: health.authMode ?? null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS);
      }
    }
  }

  return {
    surface,
    ok: false,
    attempts: MAX_ATTEMPTS,
    detail: `unreachable after ${String(MAX_ATTEMPTS)} attempts: ${String(lastError)}`,
    durationMs: null,
    sha: null,
  };
}

/**
 * Probe every surface concurrently and turn failures into findings.
 */
export async function checkLiveness(surfaces) {
  const results = await Promise.all(surfaces.map(probeSurface));

  const findings = results
    .filter((r) => !r.ok)
    .map((r) => ({
      severity: "red",
      area: "liveness",
      title: `${r.surface.label} is not healthy`,
      detail: `${r.surface.url} — ${r.detail}`,
    }));

  return { results, findings };
}
