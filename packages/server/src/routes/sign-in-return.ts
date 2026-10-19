/** Where the sign-in page and its form send the browser afterwards. */
import { localHref } from "../pages/href.js";

/**
 * Where a sign-in may send the browser afterwards: `raw` resolved against the
 * issuer, kept only when it lands on the issuer's own origin, and answered as
 * the normalized path, query and fragment. Anything else is `/`.
 *
 * Resolved rather than pattern-matched because the browser resolves it: it
 * strips tabs and newlines and reads a backslash as a slash before it looks
 * at the URL, so `/\t/evil.example` is `//evil.example` by the time it
 * navigates. The one function every door that redirects after sign-in asks.
 */
export function validateReturnTo(raw: unknown, issuer: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  let base: URL;
  let target: URL;
  try {
    base = new URL(issuer);
    target = new URL(raw, base);
  } catch {
    return "/";
  }
  if (target.origin !== base.origin) return "/";
  // A path the browser would read as another host: resolving collapses dot
  // segments, so `/a/..//evil.example` lands here as `//evil.example`.
  if (target.pathname.startsWith("//")) return "/";
  const path = `${target.pathname}${target.search}${target.hash}`;
  // The page renders this as an address, so it must pass the check every
  // rendered address passes.
  try {
    return localHref(path);
  } catch {
    return "/";
  }
}

/**
 * Build a synthetic `return_to` pointing back at `/auth/authorize` when
 * a request lands on `/auth/sign-in` with OAuth params on the URL
 * itself (rather than wrapped in an explicit `return_to`).
 *
 * Triggered by the @better-auth/oauth-provider plugin's `loginPage`
 * redirect: the plugin appends the full (verified, signed)
 * authorize-request query string directly onto `/auth/sign-in` when
 * the user isn't yet signed in. The Hono sign-in handler folds those
 * params back into a `/auth/authorize?…` URL so the existing
 * form-round-trip carries them through credential check.
 *
 * The page-local params (`error`, `retry_after`, `return_to`, `email`) are stripped before
 * re-encoding — they belong to the sign-in page's UX state, not to the
 * OAuth request.
 *
 * The return value always starts with `/auth/authorize`, so it
 * satisfies `validateReturnTo`.
 */
const SIGN_IN_LOCAL_PARAMS = new Set([
  "error",
  "retry_after",
  "return_to",
  "email",
]);

export function synthesizeOauthReturnTo(params: URLSearchParams): string {
  const filtered = new URLSearchParams();
  for (const [key, value] of params) {
    if (SIGN_IN_LOCAL_PARAMS.has(key)) continue;
    filtered.append(key, value);
  }
  const qs = filtered.toString();
  return qs.length === 0 ? "/auth/authorize" : `/auth/authorize?${qs}`;
}
