import { buildApp } from "./app.js";
import type { ControlPlaneEnv } from "./env.js";

/**
 * Cloudflare Worker entrypoint. The Hono app builder is split out so
 * tests and local-dev tooling can mount the routes without depending on
 * the Worker runtime.
 */
const app = buildApp();

/**
 * Module-level gate so the boot-time config check fires once per
 * Worker isolate (cold start) rather than on every request. Workers
 * preserve module state across requests within the same isolate.
 */
let didConfigCheck = false;

/**
 * One-shot WARN at first fetch when `CLOUDFLARE_QUEUES_API_TOKEN` is
 * unset. The DLQ peek/replay routes return 503 `cf_queues_not_configured`
 * without it (see `cf-queues-pull.ts`); webhook-receipt and reactive-run
 * routes don't depend on it. Logging-not-throwing keeps the rest of the
 * Worker functional while flagging the gap to the operator early.
 *
 * Exported so tests can drive it directly via `_resetConfigCheckForTests`.
 */
export function checkConfigOnce(env: ControlPlaneEnv): void {
  if (didConfigCheck) return;
  didConfigCheck = true;
  if (!env.CLOUDFLARE_QUEUES_API_TOKEN) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message:
          "CLOUDFLARE_QUEUES_API_TOKEN not set — DLQ peek/replay routes will return 503 cf_queues_not_configured. Set via: wrangler secret put CLOUDFLARE_QUEUES_API_TOKEN --env <env>",
      }),
    );
  }
}

/** Test-only — clears the once-per-isolate gate so each test runs from
 *  a known state. Production code should never call this. */
export function _resetConfigCheckForTests(): void {
  didConfigCheck = false;
}

export default {
  fetch(
    request: Request,
    env: ControlPlaneEnv,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    checkConfigOnce(env);
    return app.fetch(request, env, ctx);
  },
};
