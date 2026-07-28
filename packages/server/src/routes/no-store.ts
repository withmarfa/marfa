import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";

/**
 * `Pragma: no-cache` is included for HTTP/1.0 caches that don't honor
 * Cache-Control. `private` ensures intermediate caches don't share the
 * response across users.
 */
const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-cache, private",
  Pragma: "no-cache",
};

/**
 * Stamps cache-prevention headers on the current Hono response.
 *
 * Call this on every auth HTML surface before returning `c.html(...)` —
 * sign-in / sign-up / consent / OAuth callback / device verification.
 * Browsers (especially shared-machine browsers) may otherwise cache the
 * rendered page; OWASP recommends `no-store` on any page that surfaces
 * session-bound or post-authn content.
 */
export function setNoStore(c: Context<AppEnv>): void {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    c.header(name, value);
  }
}

/**
 * Same headers, for a raw `Response` a route returns without going
 * through the Hono context — a redirect built by hand, or one proxied
 * out of Better Auth.
 *
 * Load-bearing on the authorization-code redirects: the `Location` of a
 * successful authorize response carries a single-use `code` in the URL,
 * and a cached redirect leaves that code sitting in a shared cache or in
 * the browser's back-forward cache. Returns a fresh `Response` rather
 * than mutating in place, because a `Response` handed back by another
 * handler may carry an immutable header guard.
 */
export function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
