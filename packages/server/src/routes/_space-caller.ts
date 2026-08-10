/**
 * Who is calling a space-admin HTML surface, and from where.
 *
 * Most of the data plane is bearer-only: `/items` with only a session cookie
 * is a 401, deliberately. But a few routes render a page a person is meant to
 * open, and a browser navigation carries no bearer. Those routes accept
 * either credential, and the rule for doing so lives here rather than being
 * written once per route — the install surface had it and the configuration
 * surface did not, which is how pages that had been built, styled, previewed
 * and snapshotted turned out to be unopenable.
 *
 * The session branch is a different principal from the bearer branch: the
 * account holder acting on their own space, rather than a credential someone
 * minted. It resolves that person's space rather than reading one off a key.
 */
import type { Context } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { hasSpaceAdminAuthority } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { resolveSpaceIdForAuthUser } from "../auth/oauth-provider.js";

export interface SpaceCaller {
  /** Audit identity. `auth_user:<id>` when a session authorized the call. */
  apiKeyId: string;
  spaceId: string | undefined;
}

/**
 * Resolve a caller holding space-admin authority, from a bearer token or a
 * Better Auth session.
 *
 * Returns a `Response` when the caller has to go somewhere before it can
 * answer: an unauthenticated browser navigation is sent to sign-in with a
 * `return_to`, since answering 401 to a person who has simply not signed in
 * yet is a dead end. A request that presented an `Authorization` header and
 * failed still gets the 401 it asked for.
 */
export async function resolveSpaceAdminCaller(
  c: Context<AppEnv>,
  storage: Storage,
  auth: MarfaAuth | undefined,
  forbiddenMessage: string,
): Promise<SpaceCaller | Response> {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    if (!hasSpaceAdminAuthority(apiKey) && !apiKey.is_platform) {
      throw new MarfaError(ErrorCode.FORBIDDEN, forbiddenMessage);
    }
    return { apiKeyId: apiKey.id, spaceId: apiKey.space_id };
  }
  if (auth) {
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      const spaceId = await resolveSpaceIdForAuthUser(storage, session.user.id);
      return { apiKeyId: `auth_user:${session.user.id}`, spaceId };
    }
  }
  if (c.req.header("authorization")) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }
  const url = new URL(c.req.url);
  const returnTo = `${url.pathname}${url.search}`;
  return c.redirect(
    `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    302,
  );
}

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
