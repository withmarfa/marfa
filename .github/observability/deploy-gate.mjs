/**
 * Wait for a deploy to actually be serving, and say how long it took.
 *
 * `wrangler deploy` returning zero says the Worker rolled. It says nothing
 * about the container behind it, which is a separate deployable with its own
 * replacement rules — so the pipeline used to end while the previous build was
 * still answering every request, and nothing measured the gap.
 *
 * Built on `probes.mjs`, which already reads `version.sha` and already tells
 * "no instance behind the edge" apart from "the application returned 500" —
 * exactly the triage a failed gate needs. Scheduled fleet monitoring used to
 * live beside this file and now runs outside the repository entirely, so this
 * gate and its probe module are all that remain here: they answer a question
 * about one deploy, which is a build concern rather than a monitoring one.
 *
 * Polling is also what completes the roll: the container stands down when it
 * notices its image is stale, and it can only notice on a request.
 */

import { inspectHealthPayload, classifyFailure } from "./probes.mjs";
import { serverSurfaces } from "./surfaces.mjs";

/** How long to wait for the deployed build to answer. */
export const GATE_BUDGET_MS = 180_000;
/** Gap between attempts. Each one is also a nudge for the roll. */
export const GATE_INTERVAL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `url` until `/health` reports `expectedSha`.
 *
 * Returns the outcome rather than throwing, so the caller decides what a
 * failure means and the tests can drive every branch.
 */
export async function waitForDeployedBuild(url, expectedSha, options = {}) {
  const budgetMs = options.budgetMs ?? GATE_BUDGET_MS;
  const intervalMs = options.intervalMs ?? GATE_INTERVAL_MS;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const wait = options.sleep ?? sleep;

  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let attempts = 0;
  let lastSeen = null;
  let lastFailure = null;

  for (;;) {
    attempts += 1;
    try {
      const response = await fetchImpl(`${url}?deploy_gate=${String(now())}`, {
        headers: { "cache-control": "no-cache" },
      });
      const body = await response.text();
      if (response.ok) {
        const { sha, degraded, region, location } = inspectHealthPayload(body);
        lastSeen = sha;
        if (sha === expectedSha) {
          return {
            ok: true,
            attempts,
            rollWindowMs: now() - startedAt,
            degraded,
            region,
            location,
          };
        }
      } else {
        lastFailure = classifyFailure(response.status, body);
      }
    } catch (err) {
      lastFailure = {
        kind: "unreachable",
        summary: err instanceof Error ? err.message : String(err),
      };
    }

    if (now() + intervalMs >= deadline) {
      return {
        ok: false,
        attempts,
        rollWindowMs: now() - startedAt,
        lastSeen,
        lastFailure,
      };
    }
    await wait(intervalMs);
  }
}

/**
 * Compare where the deploy actually landed against where it was meant to.
 *
 * Placement has no natural alarm: a container a continent away from its
 * database fails no check, degrades no status and reports no error. It only
 * costs latency, and latency gets attributed to whichever component the
 * health payload happens to name. That is how production served every
 * request from the wrong continent for four months with a green pipeline.
 *
 * Returns a reason string when the deploy should fail, or null when it
 * should not. "The server did not report a region" is deliberately not a
 * failure: a self-hosted deployment publishes none, and a gate that treated
 * silence as a fault would fail every one of them.
 */
export function checkPlacement(expectedRegion, reported) {
  if (!expectedRegion) return null;
  if (!reported?.region) return null;
  if (reported.region === expectedRegion) return null;
  const where = reported.location ? ` (${reported.location})` : "";
  return `container is in ${reported.region}${where}, expected ${expectedRegion}`;
}

/** Which surface an environment name deploys to. Shared with the watchdog so
 *  the gate and the alarm can never disagree about where an environment is. */
export function healthUrlFor(environment) {
  const surface = serverSurfaces().find((s) => s.environment === environment);
  if (!surface) {
    throw new Error(
      `no server surface declared for environment "${environment}"`,
    );
  }
  return surface.url;
}

/* c8 ignore start -- entry point, exercised by the workflow rather than tests */
if (process.argv[1]?.endsWith("deploy-gate.mjs")) {
  const environment = process.env.DEPLOY_ENVIRONMENT;
  const expectedSha = (process.env.DEPLOY_SHA ?? "").slice(0, 7);
  // Set by the deploy script from the same value it rendered into the
  // container config, so the gate cannot check against a second opinion.
  const expectedRegion = process.env.SERVER_REGION;
  if (!environment || !expectedSha) {
    console.error(
      "deploy-gate: DEPLOY_ENVIRONMENT and DEPLOY_SHA are both required",
    );
    process.exit(2);
  }

  const url = healthUrlFor(environment);
  console.log(`→ waiting for ${environment} to serve ${expectedSha} (${url})`);
  const result = await waitForDeployedBuild(url, expectedSha);
  const seconds = (result.rollWindowMs / 1000).toFixed(1);

  if (result.ok) {
    console.log(
      `✓ ${environment} is serving ${expectedSha} after ${seconds}s (${String(result.attempts)} probe${result.attempts === 1 ? "" : "s"})`,
    );
    console.log(`roll_window_seconds=${seconds}`);
    if (result.region) {
      console.log(
        `  running in ${result.region}${result.location ? ` (${result.location})` : ""}`,
      );
    } else {
      console.log("  the server reported no placement");
    }
    if (result.degraded?.length) {
      console.log("  serving, but reporting degraded components:");
      for (const line of result.degraded) console.log(`    ${line}`);
    }

    const misplaced = checkPlacement(expectedRegion, result);
    if (misplaced) {
      console.error(`✗ ${environment} is serving from the wrong region.`);
      console.error(`  ${misplaced}`);
      console.error(
        "  Every dependency this server has is in the expected region, and the",
      );
      console.error(
        "  write path crosses to them many times per request, so this is a",
      );
      console.error(
        "  multi-second penalty rather than a marginal one. Check the",
      );
      console.error(
        "  `constraints.regions` on the container application before retrying.",
      );
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(
    `✗ ${environment} did not serve ${expectedSha} within ${seconds}s (${String(result.attempts)} probes)`,
  );
  console.error(`  last build seen: ${result.lastSeen ?? "none"}`);
  if (result.lastFailure) {
    console.error(
      `  last failure: ${result.lastFailure.kind} — ${result.lastFailure.summary}`,
    );
  }
  console.error(
    "  The container may be stranded on the previous image. See the stranded-container section of the deploy runbook.",
  );
  process.exit(1);
}
/* c8 ignore stop */
