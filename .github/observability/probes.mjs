/**
 * Liveness probes against every publicly reachable surface.
 *
 * **Each surface is sampled several times across a run, not once.** A single
 * point-in-time probe cannot see an intermittent surface: one that answers
 * when you look and fails between looks reads as healthy forever, and the
 * gaps leave no trace anywhere.
 *
 * That is not hypothetical. An earlier version of this file sampled once, and
 * during a real production incident it happened to land inside an up window
 * and recorded "ok" while the same surface was returning 500s either side of
 * it. The probe logic was correct; sampling once was the bug.
 *
 * Sampling repeatedly turns intermittency from a blind spot into its own
 * finding: samples that disagree with each other *are* the signal, and
 * "intermittent" is reported separately from "down" because the two need
 * different responses.
 */

/**
 * Hosted containers scale to zero, so the first request after an idle period
 * pays a cold start of roughly eleven to fifteen seconds. That cost is a
 * deliberate trade, which makes it a normal condition rather than an incident.
 *
 * Note what a cold start actually looks like: a **slow 200**, not an error. A
 * generous timeout is therefore the entire accommodation it needs, and a
 * non-200 is a real failure whenever it appears — never excused as warming up.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Samples per surface per run, and the gap between them.
 *
 * Three samples spread over twenty seconds spaces them widely enough to catch
 * a surface cycling on the order of tens of seconds, rather than aliasing
 * over it.
 *
 * The upper bound on the spread is billing, not usefulness: a job bills as a
 * whole minute however long it takes, so the entire run has to fit inside one.
 * That budget is measured, not assumed. Across the thirty most recent
 * scheduled runs before this change (2026-07-29, job start to job completion,
 * excluding queue time, which is not billed) the job took a median of 17
 * seconds, 29 at the 95th percentile and 34 at its worst. The sleeps are added
 * on top of that, so thirty seconds of spread would have put the 95th
 * percentile at 59 seconds and the tail past the boundary; twenty leaves the
 * 95th percentile near 50 and only the very worst run at risk of spilling
 * into a second minute. Widening this is a cost decision, not a resolution
 * one — re-measure before changing it.
 */
export const SAMPLE_COUNT = 3;
export const SAMPLE_INTERVAL_MS = 10_000;

/**
 * The most spread the billing budget above allows, in milliseconds. Exported
 * so a test fails when the sample plan grows past what was measured, rather
 * than the overrun showing up as a doubled invoice nobody connects to it.
 */
export const MAX_SAMPLE_SPREAD_MS = 20_000;

/**
 * One immediate retry within a sample, so a transient blip on the runner's
 * own network does not masquerade as intermittency. Deliberately tight: it
 * exists to reject noise, not to wait out a real outage.
 */
const SAMPLE_RETRY_DELAY_MS = 2_000;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Classify a failure by what it says about the layer underneath.
 *
 * This distinction is operational, not cosmetic. "The edge is up but there is
 * no instance behind it" and "the application returned 500" point at
 * different layers and different fixes, and flattening both to "HTTP 500"
 * discards the most useful part of the message.
 *
 * The no-instance case matters most: a service that is not running emits no
 * telemetry, so nothing derived from its own logs can see it. Error-rate and
 * restart-rate checks all go quiet, exactly as they would if everything were
 * fine. An external probe is the only thing that can tell the difference.
 */
export function classifyFailure(status, body) {
  const text = String(body ?? "");

  // Most specific first: the edge tried to start an instance and could not.
  if (/failed to start container/i.test(text)) {
    return {
      kind: "instance-will-not-start",
      summary: "the edge tried to start an instance and failed",
    };
  }
  if (
    /container is not running|error proxying request to container/i.test(text)
  ) {
    return {
      kind: "instance-not-running",
      summary: "no instance is running behind the edge",
    };
  }
  if (status >= 500) {
    return {
      kind: "server-error",
      summary: `the application returned ${String(status)}`,
    };
  }
  return { kind: "http-error", summary: `unexpected HTTP ${String(status)}` };
}

/**
 * Inspect a `/health` payload for components reporting anything other than
 * ok. A 200 with a downed database is still an outage; the status code alone
 * is not the whole signal.
 */
export function inspectHealthPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { degraded: ["health payload was not valid JSON"], sha: null };
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
    degraded,
    sha: payload.version?.sha ? String(payload.version.sha) : null,
    // Absent on a self-hosted server, which publishes no placement at all,
    // so a caller has to tell "not reported" apart from "reported wrong"
    // rather than reading a missing field as agreement.
    region: payload.placement?.region ? String(payload.placement.region) : null,
    location: payload.placement?.location
      ? String(payload.placement.location)
      : null,
  };
}

async function attempt(surface) {
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
  return {
    status: response.status,
    durationMs: Date.now() - startedAt,
    body: await response.text(),
  };
}

/** One sample: a single attempt, retried once on failure to reject noise. */
async function takeSample(surface) {
  for (let tries = 0; tries < 2; tries += 1) {
    const isLastTry = tries === 1;
    try {
      const result = await attempt(surface);

      if (result.status !== 200) {
        if (!isLastTry) {
          await sleep(SAMPLE_RETRY_DELAY_MS);
          continue;
        }
        return {
          ok: false,
          ...classifyFailure(result.status, result.body),
          durationMs: result.durationMs,
          sha: null,
        };
      }

      if (surface.kind !== "server") {
        return { ok: true, durationMs: result.durationMs, sha: null };
      }

      const health = inspectHealthPayload(result.body);
      if (health.degraded.length > 0) {
        return {
          ok: false,
          kind: "degraded",
          summary: health.degraded.join("; "),
          durationMs: result.durationMs,
          sha: health.sha,
        };
      }
      return { ok: true, durationMs: result.durationMs, sha: health.sha };
    } catch (error) {
      if (!isLastTry) {
        await sleep(SAMPLE_RETRY_DELAY_MS);
        continue;
      }
      return {
        ok: false,
        kind: "unreachable",
        summary: error instanceof Error ? error.message : String(error),
        durationMs: null,
        sha: null,
      };
    }
  }
  /* c8 ignore next */
  throw new Error("unreachable: sample loop always returns");
}

/**
 * Reduce a surface's samples to a verdict.
 *
 * Exported and pure so the interesting part — the mapping from "which samples
 * failed" to "what to call it" — can be reasoned about without a network.
 */
export function summarizeSamples(surface, samples) {
  const failures = samples.filter((s) => !s.ok);
  const successes = samples.filter((s) => s.ok);
  const durations = successes
    .map((s) => s.durationMs)
    .filter((d) => d !== null && d !== undefined);

  const base = {
    surface,
    samples: samples.length,
    failed: failures.length,
    sha: successes.find((s) => s.sha)?.sha ?? null,
    durationMs: durations.length > 0 ? Math.max(...durations) : null,
  };

  // No samples is not a passing surface, it is an unprobed one. Reaching the
  // "no failures" branch with an empty array would report `up` on evidence
  // nobody gathered — a fail-open in the one function whose stated purpose is
  // to stop a probe claiming health it did not observe. This has to come
  // first: zero failures out of zero samples satisfies every test below it.
  if (samples.length === 0) {
    return {
      ...base,
      ok: false,
      state: "not-probed",
      kind: "not-probed",
      detail:
        "no samples were taken, so nothing is known about this surface. An " +
        "unprobed surface is reported rather than assumed healthy: silence " +
        "here would be indistinguishable from a clean run.",
    };
  }

  if (failures.length === 0) {
    return { ...base, ok: true, state: "up" };
  }

  const kinds = [...new Set(failures.map((f) => f.kind))];
  const summaries = [...new Set(failures.map((f) => f.summary))];

  if (failures.length === samples.length) {
    return {
      ...base,
      ok: false,
      state: "down",
      kind: kinds[0],
      detail: `all ${String(samples.length)} samples failed — ${summaries.join("; ")}`,
    };
  }

  // Some samples up, some down, within one run. This is the case a
  // single-sample probe cannot see at all. It deserves its own name: the
  // surface is failing a fraction of real traffic while still looking fine to
  // anything that checks once.
  const successRate = Math.round((successes.length / samples.length) * 100);
  return {
    ...base,
    ok: false,
    state: "intermittent",
    kind: kinds[0],
    detail:
      `${String(failures.length)} of ${String(samples.length)} samples failed within this run — ` +
      `${summaries.join("; ")}. The surface is serving some requests and failing ` +
      `others, so a check that sampled once would have called it healthy about ` +
      `${String(successRate)}% of the time.`,
  };
}

const FINDING_TITLE = {
  intermittent: (label) => `${label} is intermittently failing`,
  "not-probed": (label) => `${label} was not probed`,
  down: (label) => `${label} is down`,
};

/**
 * Probe every surface repeatedly and turn the results into findings.
 *
 * `sleep` is injectable so a test can assert that the samples are actually
 * spread rather than taken back to back. The spacing is the whole reason this
 * function exists — a run that took its three samples in the same instant
 * would pass every assertion about the verdict mapping while seeing exactly
 * what one sample sees.
 */
export async function checkLiveness(surfaces, options = {}) {
  // `??` does not fall back on `0`, so a caller passing zero would otherwise
  // run no rounds at all and get a green fleet built from nothing. Clamp
  // rather than reject: a probe stage that quietly does nothing is the failure
  // being guarded against, and refusing to run at all is the same outcome.
  const requested = options.sampleCount ?? SAMPLE_COUNT;
  const sampleCount = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : SAMPLE_COUNT;
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const wait = options.sleep ?? sleep;

  // Keyed by position, not by `id`. Two surfaces sharing an id collapse into
  // one bucket, and both then summarize the same merged samples — a surface
  // that is up and one that is down would each be reported as intermittent.
  const collected = surfaces.map(() => []);

  for (let round = 0; round < sampleCount; round += 1) {
    if (round > 0) await wait(intervalMs);
    const roundResults = await Promise.all(
      surfaces.map((surface) => takeSample(surface)),
    );
    roundResults.forEach((sample, index) => collected[index].push(sample));
  }

  const results = surfaces.map((surface, index) =>
    summarizeSamples(surface, collected[index]),
  );

  const findings = results
    .filter((r) => !r.ok)
    .map((r) => ({
      severity: "red",
      area: r.state === "intermittent" ? "flapping" : "liveness",
      title: (FINDING_TITLE[r.state] ?? FINDING_TITLE.down)(r.surface.label),
      detail: `${r.surface.url} — ${r.detail}`,
    }));

  return { results, findings };
}
