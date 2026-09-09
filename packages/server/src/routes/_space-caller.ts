/**
 * Who is calling a space-scoped HTML surface, and from where.
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
 * minted. It resolves that person's space rather than reading one off a key —
 * and in keys mode, where there is no per-user space model, it resolves the
 * instance's one space rather than answering with none.
 */
import type { Context } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { SpacePermission } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";

export interface SpaceCaller {
  /** Audit identity. `auth_user:<id>` when a session authorized the call. */
  apiKeyId: string;
  /**
   * The space this call acts on. Never `undefined` for a session caller, in
   * either mode: downstream, an absent space is not "no space" but "no space
   * filter", so a caller whose space could not be resolved is refused rather
   * than handed the instance tier. A bearer caller may still be space-less,
   * because the operator key legitimately is.
   */
  spaceId: string | undefined;
}

/**
 * Resolve the caller of a space-scoped surface, from a bearer token or a
 * Better Auth session, and hold it to the permission that surface requires.
 *
 * Returns a `Response` when the caller has to go somewhere before it can
 * answer: an unauthenticated browser navigation is sent to sign-in with a
 * `return_to`, since answering 401 to a person who has simply not signed in
 * yet is a dead end. A request that presented an `Authorization` header and
 * failed still gets the 401 it asked for.
 */
export async function resolveSpaceCaller(
  c: Context<AppEnv>,
  storage: Storage,
  auth: MarfaAuth | undefined,
  forbiddenMessage: string,
  permission: SpacePermission,
): Promise<SpaceCaller | Response> {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    // **The permission belongs here rather than at the five call sites.** This
    // resolver is not itself a surface — it answers which space a request acts
    // in, which is why it carries none of its own — but everything it admits is
    // one. Gating the callers one at a time is what left the `GET` half of a
    // door open while its `POST` twin, one function away in the same file, was
    // closed. A required parameter means a new surface cannot be added without
    // answering the question.
    //
    // It is also the whole gate now. There used to be a rank test in front of
    // it, admitting a space admin or an operator flag before the permission was
    // consulted at all; a bearer that cleared the rank and held nothing reached
    // every surface behind this resolver. One question, asked once.
    requireSpacePermission(c, permission);
    return { apiKeyId: apiKey.id, spaceId: apiKey.space_id };
  }
  if (auth) {
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      // No users store means keys mode: a single-space self-host, where there
      // is no per-user space model to resolve against. The answer used to be
      // `undefined` on the reasoning that a space-less caller there is not
      // unscoped authority but the only space the instance has — which was
      // true while nothing on such an instance had a space, and is not now.
      //
      // **`undefined` is "no space filter" downstream, and that is a different
      // thing from "the instance's space".** A connection installed through
      // one of these pages would be written space-less while the instance's
      // working credential is bound to a space, so the row it just made would
      // be invisible to it — and the runtime credential the connection needs
      // cannot be minted at all, because a space-less non-operator credential
      // is the one shape the row constraint refuses.
      //
      // So the instance's one space is resolved and handed back. One is the
      // shape both provisioning paths aim at — the migration creates it where
      // an instance has none, and bootstrap creates it where the migration
      // found nothing to move — but neither can promise it: `POST
      // /admin/spaces` is open to the operator key on a keys-mode instance
      // like any other, and `POST /admin/spaces/{id}/delete` is too.
      if (!storage.users) {
        const spaces = (await storage.spaces?.list()) ?? [];
        const only = spaces[0];
        if (spaces.length !== 1 || !only) {
          // Nothing here can pick between two, and there is nothing to act in
          // when there are none. Refusing names the state; guessing would
          // write into whichever the store happened to return first.
          //
          // Its own message, not the caller's. Every surface behind this
          // resolver phrases its refusal as something about the caller's
          // account — "your account is not attached to a space" — which is
          // true in hosted mode and false here, where a keys-mode instance
          // has no accounts at all. A person reading that goes looking for an
          // account problem that does not exist, when what is wrong is the
          // number of spaces on the instance and the fix is an operator's.
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            spaces.length === 0
              ? "This instance has no space, so there is nothing for these pages to act in. Create one with POST /admin/spaces using the operator key."
              : `This instance has ${String(spaces.length)} spaces. These pages resolve the one space a self-hosted instance has, and cannot choose between several. Remove the spares with POST /admin/spaces/{id}/delete using the operator key.`,
          );
        }
        return { apiKeyId: `auth_user:${session.user.id}`, spaceId: only.id };
      }
      // Being signed in is not authority: what a session buys is a space to
      // act in, and that space has to resolve.
      const user = await storage.users.getByAuthUserId(session.user.id);
      // **A signed-in person whose account resolves to a space is admitted,
      // and that is the whole test.** One account holds one space and the
      // first person in it holds everything, so a rank comparison here was
      // asking which of three kinds of person this was and always getting the
      // same answer. What a person may do is their permission set; these pages
      // are part of the consent surface rather than something reached through
      // it, so there is no grant behind the session for a permission to have
      // been ticked on.
      //
      // An unresolved account, or one with no space, is refused rather than
      // passed on. See `SpaceCaller`.
      if (!user?.space_id) {
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
