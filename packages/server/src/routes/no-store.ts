import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";

/**
 * Stamps cache-prevention headers on the current Hono response.
 *
 * Call this on every auth HTML surface before returning `c.html(...)` —
 * sign-in / sign-up / consent / OAuth callback / device verification.
 * Browsers (especially shared-machine browsers) may otherwise cache the
 * rendered page; OWASP recommends `no-store` on any page that surfaces
 * session-bound or post-authn content.
 *
 * `Pragma: no-cache` is included for HTTP/1.0 caches that don't honour
 * Cache-Control. `private` ensures intermediate caches don't share the
 * response across users.
 */
export function setNoStore(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store, no-cache, private");
  c.header("Pragma", "no-cache");
}
