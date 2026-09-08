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
import {
  ErrorCode,
  MarfaError,
  parseMarfaRole,
  ROLE_RANK,
} from "@withmarfa/shared";
import type { SpacePermission } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  hasSpaceAdminAuthority,
  requireSpacePermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";

export interface SpaceCaller {
  /** Audit identity. `auth_user:<id>` when a session authorized the call. */
  apiKeyId: string;
  /**
   * The space this call acts on. Never `undefined` for a session caller:
   * downstream, an absent space is not "no space" but "no space filter",
   * so a caller whose space could not be resolved is refused rather than
   * handed the platform tier. A bearer caller may still be space-less,
   * because a platform credential legitimately is.
   */
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
  permission: SpacePermission,
): Promise<SpaceCaller | Response> {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    if (!hasSpaceAdminAuthority(apiKey) && !apiKey.is_platform) {
      throw new MarfaError(ErrorCode.FORBIDDEN, forbiddenMessage);
    }
    // **The capability belongs here rather than at the five call sites.** This
    // resolver is not itself a surface — it answers which space a request acts
    // in, which is why it carries no capability of its own — but everything it
    // admits is one, and admitting on space-admin rank is reachable by an OAuth
    // bearer through the projected role. Gating the callers one at a time is
    // what left the `GET` half of a door open while its `POST` twin, one
    // function away in the same file, was closed. A required parameter means a
    // new surface cannot be added without answering the question.
    //
    // The bearer branch only. A browser session below carries no `apiKey`, so
    // `requireSpacePermission` would answer 401 to a person who is signed in — and
    // there is no grant behind a session for a capability to have been ticked
    // on, because these pages are part of the consent surface rather than
    // something reached through it.
    requireSpacePermission(c, permission);
    return { apiKeyId: apiKey.id, spaceId: apiKey.space_id };
  }
  if (auth) {
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      // No users store means keys mode: a single-space self-host, where
      // there is no per-user space model to resolve against and no role
      // to read. A space-less caller there is not unscoped authority, it
      // is the only space the instance has. Hosted mode is the case
      // below, and the two must not share an answer.
      if (!storage.users) {
        return { apiKeyId: `auth_user:${session.user.id}`, spaceId: undefined };
      }
      // Being signed in is not authority. The bearer branch above has
      // always required space-admin rank; this branch required only a
      // session, so any member of a space could install an integration
      // or rewrite its configuration by opening the page. Sign-up
      // provisions the account holder as `space_admin`, so an ordinary
      // owner is unaffected — what this refuses is a member of someone
      // else's space, and a session with no space record at all.
      const user = await storage.users.getByAuthUserId(session.user.id);
      // Rank lookup on a parsed role, never on the raw one. An unknown
      // role makes `ROLE_RANK[...]` undefined, and `undefined < 2` is
      // false, so the comparison admits exactly what it means to refuse.
      // The store narrows on read, so this is belt and braces, but it is
      // the difference between failing open and failing closed for a
      // caller constructed some other way.
      if (
        !user ||
        ROLE_RANK[parseMarfaRole(user.role)] < ROLE_RANK.space_admin
      ) {
        throw new MarfaError(ErrorCode.FORBIDDEN, forbiddenMessage);
      }
      // An unresolved space is refused, never passed on. See `SpaceCaller`.
      if (!user.space_id) {
        throw new MarfaError(ErrorCode.FORBIDDEN, forbiddenMessage);
      }
      return {
        apiKeyId: `auth_user:${session.user.id}`,
        spaceId: user.space_id,
      };
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
