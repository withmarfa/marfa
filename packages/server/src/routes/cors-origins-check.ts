/**
 * CORS-origins boot guard — warns loud at boot if a hosted deployment runs
 * with an empty `CORS_ORIGINS`.
 *
 * In hosted mode the browser apps (web client, console, …) sign in via the
 * server's hosted auth pages and then call the data plane cross-origin. With
 * no allowed origins the browser's preflight fails and every authenticated
 * request 401s with no obvious server-side error — a confusing dead end for a
 * self-hoster who forgot to set the var. The guard makes it unmissable.
 *
 * A warning rather than a hard refuse-to-start: an API-only or same-origin
 * hosted deployment is legitimately fine with no CORS origins, so blocking boot
 * would be wrong. Keys-mode self-hosts (single-user, typically no browser
 * client) never warn. Test environments skip the check.
 *
 * Mirrors the `checkRedirectAllowlist` boot-guard pattern in
 * `redirect-allowlist-check.ts`.
 */
import { log } from "../middleware/logger.js";

export interface CorsOriginsCheckOptions {
  authMode: "hosted" | "keys";
  corsOrigins: readonly string[];
  /** When true, skip the check (test contexts). Defaults to
   *  NODE_ENV-derived. */
  skip?: boolean;
}

/**
 * Emits a loud startup warning when the deployment is in hosted mode and the
 * CORS origin allowlist is empty. No-op in keys mode, when the list is
 * non-empty, or under test.
 */
export function checkCorsOrigins(opts: CorsOriginsCheckOptions): void {
  const skip =
    opts.skip ?? (process.env.NODE_ENV === "test" || !process.env.NODE_ENV);
  if (skip) return;
  if (opts.authMode !== "hosted") return;
  if (opts.corsOrigins.length > 0) return;
  log(
    "warn",
    "CORS_ORIGINS is empty in hosted mode — browser clients that sign in via " +
      "the hosted auth pages will fail their cross-origin API calls (every " +
      "authenticated request fails the preflight). Set CORS_ORIGINS to the " +
      "browser app origins (comma-separated) to enable them.",
  );
}
