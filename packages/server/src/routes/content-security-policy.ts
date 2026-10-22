/**
 * The content security policy for the pages the server renders.
 *
 * Those pages (sign-in, consent, device approval, the signed-in and error
 * pages) act on the owner's signed-in session, so a policy that lets only
 * what the page itself names run limits what an injection into one of them
 * can do. A script runs, and a style applies, only if it carries this
 * response's nonce.
 *
 * **No script or style is allowed by origin, which is why a nonce is named on
 * the static files too.** The same origin serves a blob's bytes at its link
 * door, without a credential and under whatever type the uploader named, so a
 * `'self'` source would let an injection load an uploaded script or
 * stylesheet. The pages carry the nonce on their own script and stylesheet
 * tags, and use no inline style: a style attribute takes no nonce, so it
 * could only be allowed by allowing every inline style.
 *
 * Pages that fetch their own endpoints add `connect-src 'self'`; this does
 * not allow scripts or styles by origin. The console pages also add
 * `'self'` to `img-src` for the owner's picture, which the instance serves
 * from its own address with a sandbox policy and `nosniff`, so an image
 * source by origin cannot become a script or a style.
 *
 * **The baseline leaves `form-action` unset.** The consent decision answers
 * a form post with a redirect to the app's own callback, and a browser holds
 * that redirect to
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

function policy(nonce: string, images: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `img-src ${images}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The policy naming `nonce`. */
export function contentSecurityPolicy(nonce: string): string {
  return policy(nonce, "data:");
}

/**
 * The policy for a console page: the baseline, and the page's own origin for
 * the requests its script makes (signing out, confirming it's you), for the
 * forms it posts and for the owner's picture.
 */
export function consoleContentSecurityPolicy(nonce: string): string {
  return `${policy(nonce, "'self' data:")}; connect-src 'self'; form-action 'self'`;
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
