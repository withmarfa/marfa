/**
 * Header forwarding for internal Better Auth dispatches.
 *
 * Several Marfa-owned auth routes wrap a Better Auth endpoint: they take
 * the browser's request, do Marfa-side work, then hand a synthesized
 * `Request` to `auth.handler(...)`. That inner request has to carry the
 * caller's session cookie, and it has to satisfy Better Auth's own
 * trusted-origins check. The client address is not forwarded: the handler
 * takes the one Marfa resolved.
 *
 * Forwarding the browser's headers verbatim does not achieve the second
 * part. Better Auth validates `Origin` (falling back to `Referer`) on
 * every cookie-bearing non-GET, and a top-level browser navigation sends
 * no `Origin` at all, so a wrapper reached by navigation would dispatch
 * an origin-less POST and be rejected. `fallbackOrigin` closes that: when
 * the inbound request has no `Origin`, the dispatch is stamped with the
 * issuer's own origin, which is what the internal hop actually is. A
 * foreign origin never reaches a POST wrapper: the cross-origin guard in
 * front of each refuses it (`_cross-origin.ts`). The GET wrappers, the
 * consent skip on `GET /auth/authorize` and `GET /auth/oauth2/end-session`,
 * have no such guard.
 */
/** Headers copied from the inbound request onto the internal dispatch. */
const PASSTHROUGH_HEADERS = [
  "origin",
  "cookie",
  "user-agent",
  "accept-language",
] as const;

/**
 * What tells the provider a request is a person navigating rather than a
 * program calling: `Accept` and the browser's fetch metadata. Forwarded only
 * by a wrapper that fronts a page a person lands on, and never by the
 * rest, so that the answer to a program is not changed by a header it sends
 * for another reason.
 */
const NAVIGATION_HEADERS = [
  "accept",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-site",
  "sec-fetch-user",
] as const;

/**
 * Build the header set for an internal Better Auth dispatch: `base`
 * (typically `content-type`) plus the passthrough headers above, and
 * `fallbackOrigin` as the `Origin` when the inbound request sent none.
 * `navigation` adds the headers by which the provider tells a browser
 * navigation from a program, for the wrapper whose answer is a page a person
 * reads: without them the provider answers a browser in JSON.
 *
 * Callers that deliberately want the inbound request's own origin to be
 * the one Better Auth judges, because a missing origin should be
 * rejected rather than papered over, omit `fallbackOrigin`.
 */
export function forwardHeaders(
  src: Headers,
  base: Record<string, string>,
  fallbackOrigin?: string,
  navigation = false,
): Headers {
  const out = new Headers(base);
  const names = navigation
    ? [...PASSTHROUGH_HEADERS, ...NAVIGATION_HEADERS]
    : PASSTHROUGH_HEADERS;
  for (const name of names) {
    const value = src.get(name);
    if (value) out.set(name, value);
  }
  if (fallbackOrigin && !out.get("origin")) {
    out.set("origin", fallbackOrigin);
  }
  return out;
}
