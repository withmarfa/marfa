/**
 * The content security policy for the pages the server renders.
 *
 * Those pages (sign-in, consent, device approval, the signed-in and error
 * pages) act on the owner's signed-in session, so a policy that allows only
 * the server's own scripts and styles limits what an injection into one of
 * them can do. A script runs only if it is served from this origin or
 * carries this response's nonce, and a style only if it is served from this
 * origin: the pages use no inline style, and an inline style attribute takes
 * no nonce, so it could only be allowed by allowing every inline style.
 *
 * **`form-action` is not set.** The consent decision answers a form post with
 * a redirect to the app's own callback, and a browser holds that redirect to
 * `form-action` too, so naming this origin would stop every approval.
 *
 * **The policy is added after the door has answered, and only where the door
 * sent none.** The blob doors send `sandbox; default-src 'none'` for bytes an
 * uploader chose, and a policy set ahead of the handler, or by the security
 * headers that write after it, would replace theirs. What is left to this
 * middleware is every answer that is a page: it reads the answer's own type,
 * so a door added tomorrow that answers HTML is covered without being named.
 */
import { randomBytes } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../middleware/auth.js";

/** The policy naming `nonce`. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Gives each request a nonce a page can carry, and puts the policy naming it
 * on any HTML answer that has none of its own.
 */
export const pageSecurityPolicy = createMiddleware<AppEnv>(async (c, next) => {
  const nonce = randomBytes(16).toString("base64");
  c.set("cspNonce", nonce);
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (
    type.toLowerCase().startsWith("text/html") &&
    !c.res.headers.has("content-security-policy")
  ) {
    c.res.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  }
});
