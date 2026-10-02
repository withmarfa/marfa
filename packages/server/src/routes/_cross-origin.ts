/**
 * The cross-origin guard on the browser doors Marfa serves under `/auth`.
 *
 * A browser navigation carries no bearer, so a page a person is meant to
 * open is gated on a session cookie instead, and a form post under a cookie
 * has to prove it came from this origin before the cookie is honored. Better
 * Auth checks the origin of the requests it serves itself, but Marfa's doors
 * reach it in-process, where that check does not run, so the guard sits in
 * front of each Marfa door instead.
 */
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";

/**
 * Every state-changing door Marfa serves under `/auth` that a browser
 * reaches, spelled as Hono registers them. `app.ts` puts the guard in front
 * of each, and `auth-origin-guard.test.ts` holds this list to the app's own
 * route table.
 *
 * The sign-in form and the device code form are here though they are not
 * gated on a session cookie: the first sets one, so a foreign page posting
 * to it could sign a visitor into another account, and the second is the
 * start of an approval.
 */
export const BROWSER_FORM_DOORS: readonly string[] = [
  "POST /auth/sign-in",
  "POST /auth/device",
  "POST /auth/device/consent",
  "POST /auth/authorize/decision",
];

function originOf(value: string): string | undefined {
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
function requestOrigin(headers: Headers): string | undefined {
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
function isCrossOriginPost(
  headers: Headers,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = requestOrigin(headers);
  return origin !== undefined && !allowedOrigins.has(origin);
}

/** Refuses a request from a present, non-allowlisted origin with `403`. */
export function crossOriginGuard(
  allowedOrigins: ReadonlySet<string>,
): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (isCrossOriginPost(c.req.raw.headers, allowedOrigins)) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Cross-origin request refused",
      );
    }
    await next();
  });
}
