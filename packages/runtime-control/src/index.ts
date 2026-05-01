import { buildApp } from "./app.js";
import type { ControlPlaneEnv } from "./env.js";

/**
 * Cloudflare Worker entrypoint. The Hono app builder is split out so
 * tests and local-dev tooling can mount the routes without depending on
 * the Worker runtime.
 */
const app = buildApp();

export default {
  fetch(
    request: Request,
    env: ControlPlaneEnv,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
