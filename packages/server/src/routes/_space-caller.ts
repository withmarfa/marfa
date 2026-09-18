/**
 * The cross-origin guard the session-gated form posts share.
 *
 * A browser navigation carries no bearer, so a page a person is meant to open
 * is gated on a session cookie instead, and a form post under a cookie has to
 * prove it came from this origin before the cookie is honored.
 */
// ---------------------------------------------------------------------------
// Cross-origin guard for session-gated form posts
// ---------------------------------------------------------------------------

export function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * The origin a request came from: the `Origin` header when present, else the
 * origin of `Referer`. Undefined when neither is present, which a same-origin
 * form POST may legitimately be.
 */
export function requestOrigin(headers: Headers): string | undefined {
  const origin = headers.get("origin");
  if (origin) return origin;
  const referer = headers.get("referer");
  if (referer) return originOf(referer);
  return undefined;
}

/**
 * Every operator CORS origin plus the auth issuer's own, which is where a
 * same-origin post from a page this server rendered comes from.
 */
export function buildAllowedOrigins(
  corsOrigins: readonly string[],
  authBaseUrl: string | undefined,
): ReadonlySet<string> {
  const allowed = new Set<string>(corsOrigins);
  const base = authBaseUrl === undefined ? undefined : originOf(authBaseUrl);
  if (base) allowed.add(base);
  return allowed;
}

/**
 * True when a form post arrived from an origin that is present and not
 * allowlisted. A missing origin passes: a same-origin form POST may send
 * neither header, and rejecting those would break the ordinary case to
 * defend against one the browser's own `SameSite=Lax` already covers.
 */
export function isCrossOriginPost(
  headers: Headers,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = requestOrigin(headers);
  return origin !== undefined && !allowedOrigins.has(origin);
}
