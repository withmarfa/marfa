import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import {
  MarfaError,
  ErrorCode,
  parseScope,
  isTypeScope,
  isValidScope,
  isContentScope,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  isValidHandle,
  isReservedHandle,
  canGrantRole,
  GLOBAL_TYPE_WILDCARD,
} from "@withmarfa/shared";
import type { MarfaRole } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  isReservedCredentialSource,
  requireSpacePermission,
  requireSpaceAdmin,
  hashApiKey,
  stampOAuthGrantLastUsed,
  hasPlatformAuthority,
} from "../middleware/auth.js";
import {
  mergeDeviceApprovalScopes,
  intersectDeviceScopes,
} from "./device-scope-merge.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import {
  buildAllowedScopes,
  REFRESH_TOKEN_PREFIX,
} from "../auth/oauth-provider.js";
import {
  bundlePublishedScopes,
  catchUpClientScopeCeiling,
} from "../auth/ceiling-catchup.js";
import { getPermissionBundles } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type {
  MarfaAuth,
  MarfaAuthSession,
  MarfaAuthSessionUser,
} from "../auth/instance.js";
import {
  renderSignInPage,
  synthesizeOauthReturnTo,
  validateReturnTo,
} from "./sign-in-page.js";
import { resolveWebAppInstanceLink } from "./web-app-instance-link.js";
import { renderSignUpPage } from "./sign-up-page.js";
import { renderVerifyEmailPage } from "./verify-email-page.js";
import {
  renderSignInLinkFailedPage,
  hostFromBaseUrl,
} from "./sign-in-link-page.js";
import { renderSignedOutPage } from "./signed-out-page.js";
import { renderKeysPage, type KeysPageKey } from "./keys-page.js";
import { renderPasskeyEnrollPage } from "./passkey-enroll-page.js";
import { renderForgotPasswordPage } from "./forgot-password-page.js";
import { renderResetPasswordPage } from "./reset-password-page.js";
import {
  renderSecurityPage,
  type SecurityPageGrant,
  type SecurityPageSession,
} from "./security-page.js";
import { PerEmailThrottle } from "../auth/per-email-throttle.js";
import { isWithheldFromAllowlist } from "../auth/allowlist-withholding.js";
import { withConsentLock } from "../auth/consent-lock.js";
import {
  auditGrantRevoked,
  revokeProjectedGrant,
} from "../auth/grant-lifecycle.js";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";
import { setNoStore } from "./no-store.js";
import { forwardHeaders } from "./forward-headers.js";
import { publish } from "../pubsub.js";
import { log } from "../middleware/logger.js";
import type { OidcSigner } from "../auth/oidc-signing.js";
import type { EvaluatePendingDeletion } from "../middleware/account-deletion-guard.js";

const ACCESS_TOKEN_PREFIX = "marfa_at_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * The widest verb among the `<type>:<verb>` scopes the console form was
 * ticked for, or null when it was ticked for none of them.
 *
 * Type scopes only, and asked of the parser. What a person picks on that
 * form is which of their content an app may read or change, and the key's
 * reach across the space is mirrored from it. A permission that is not a
 * type scope has no opinion on that question however its literal happens to
 * end: `metadata.types:write` registers a type, `edge.parent-of:write` names
 * one relation, and reading either as "the owner asked for write" hands the
 * key authority nobody chose.
 *
 * **The name says type scope rather than content on purpose.** A
 * `content:read` literal is a grant over the content category and this
 * answers null for it, because `isTypeScope` is false for the kind by
 * design. That is the right answer only because the mint drops a content
 * literal at the form boundary before this ever sees one; read as "the level
 * of reach over content" it would be a silent lie, which is exactly what the
 * key minted from an admitted literal used to tell its owner.
 */
function pickedTypeScopeLevel(scopes: string[]): "read" | "write" | null {
  let level: "read" | "write" | null = null;
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (!parsed || !isTypeScope(parsed)) continue;
    if (parsed.operation === "write") return "write";
    if (parsed.operation === "read") level = "read";
  }
  return level;
}

/**
 * The edge grants a self-serve key is minted with: what its own
 * `edge.<type>:<verb>` permissions name, plus a global entry mirroring the
 * level picked for content.
 *
 * The mirror is why the wildcard is here rather than an enumerated set. A
 * space's edge types include every one it registers at runtime, so a set
 * fixed at mint time silently omits each one created afterwards, and a key
 * that cannot write edges cannot seed, migrate or restore the space it
 * belongs to. It is narrower than it reads: an edge mutation dual-gates on
 * the source item's type as well, so a key scoped to notes still only builds
 * edges out of notes.
 *
 * A named edge type is dropped once the wildcard already covers it, because
 * `edgePermissionCovers` gives an exact id precedence over a pattern. Keeping
 * a `read` entry for `parent-of` beside a `write` wildcard would deny writes
 * on the one relation the owner named and allow them everywhere else.
 */
function selfServeEdgePermissions(
  scopes: string[],
  contentLevel: "read" | "write" | null,
): Record<string, "read" | "write"> {
  const named = scopesToEdgePermissions(scopes);
  // A named global permission outranks the mirror, and the mirror only has to
  // beat it when it is the wider of the two. Testing `named` for "write" as
  // well would be a clause that can never decide anything, since the fallback
  // already yields it.
  const wildcard =
    contentLevel === "write"
      ? "write"
      : (named[GLOBAL_TYPE_WILDCARD] ?? contentLevel);
  if (wildcard === null) return named;

  const permissions: Record<string, "read" | "write"> = {
    [GLOBAL_TYPE_WILDCARD]: wildcard,
  };
  for (const [edgeType, level] of Object.entries(named)) {
    if (edgeType === GLOBAL_TYPE_WILDCARD) continue;
    if (level === "write" && wildcard === "read") {
      permissions[edgeType] = level;
    }
  }
  return permissions;
}

/**
 * Persist (or refresh) a `kind: app` connection through `ItemStore`. Routes
 * through `ItemStore.create` on first consent and `ItemStore.update` on
 * re-consent so the row gets full ItemStore treatment: `space_id`
 * stamping, search indexing, metadata-row insertion, versions snapshot on
 * re-consent, the `created`/`updated` event emission, and `source` /
 * `origin` stamping. Returns the connection-item id, whether the call
 * created vs updated the projection, and the scope list the record now
 * holds, which on re-consent is the merge rather than the request, so the
 * caller's audit row can report both without recomputing it.
 *
 * Uses `findGrantItemId` to detect the re-consent case and routes through
 * `items.update` (same shape as the code-flow consent's
 * `projectGrantOnConsent`). Status flips to "active" + `revoked_at` is
 * cleared on re-consent to avoid stale-revoked projections. The scopes it
 * writes there are the merge described in `device-scope-merge.ts`, not the
 * request. That merge may widen a standing grant and never shrinks one, even
 * though the device screen now offers per-scope toggles: an untick there
 * reaches the token this device is issued rather than the record, for the
 * reasons at that function. A revoked grant is not a standing one, so it
 * merges against nothing and the record comes back at the approval alone.
 *
 * **`source` is the device literal and not the wider union it used to
 * declare.** There is one caller. The merge rule inside is specific to the
 * device surface, and the authorize surface has the deliberate opposite
 * contract: a narrowing there is a decision the user made and revokes the
 * tokens carrying what was dropped. Advertising this
 * function as serving both would let a future authorize caller pick it up
 * and silently disable that revoke.
 *
 * `spaceId` resolves from the consenting Better Auth user's marfa `users`
 * row in hosted mode; in single-space mode (no `users` store) the grant
 * is stamped space-less. Hosted mode without a provisioned space for the
 * authenticated user refuses outright — the OAuth flow can't honor a
 * grant without a space to scope it to.
 */
async function createUserAppGrant(
  storage: Storage,
  consentingUser: MarfaAuthSessionUser,
  clientId: string,
  scopes: string[],
  source: "marfa/oauth/device",
): Promise<{
  id: string;
  created: boolean;
  scopes: string[];
  spaceId: string | undefined;
}> {
  // Cycle metadata flows through `cycleRequestContext` (set by
  // `cycleMiddleware`) — `publish()` reads it automatically.
  let spaceId: string | undefined;
  if (storage.users) {
    // Lookup by Better Auth user id (the canonical bridge); the
    // `users` table keys on auth user id, not email.
    const user = await storage.users.getByAuthUserId(consentingUser.id);
    spaceId = user?.space_id;
    if (!spaceId) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "No Marfa space is provisioned for this account; complete onboarding first",
      );
    }
  }
  const now = new Date().toISOString();

  // Detect re-consent — update in place if a projection exists, else insert.
  let existingItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    existingItemId = await storage.oauthProvider.findGrantItemId({
      spaceId: spaceId ?? null,
      clientId,
      authUserId: consentingUser.id,
    });
  }

  if (existingItemId) {
    // Re-consent: flip status back to "active" + clear revoked_at; same
    // rationale as projectGrantOnConsent in auth-consent.ts.
    const existing = await storage.items.get(existingItemId, spaceId);
    if (!existing) {
      // Race — findGrantItemId saw a row but a concurrent delete
      // raced. Fall through to insert.
    } else {
      // Merge rather than overwrite. `device-scope-merge.ts` carries the
      // reasoning; the short version is that this screen confirms a scope
      // list instead of offering one to edit, so a narrower request is the
      // client's doing and not the user's, and writing it straight in would
      // shrink what the browser already granted while leaving the tokens
      // carrying the removed scopes alive.
      //
      // **A revoked grant contributes nothing to that merge, because the
      // rule is about a STANDING grant and a revoked one is not standing.**
      // `findGrantItemId` matches on (space, client, user) and has no status
      // predicate, so it hands back a revoked row as readily as a live one,
      // and `revokeProjectedGrant` above leaves `scopes` verbatim on the row
      // it flips. Merging against that set folds a scope the user explicitly
      // withdrew back into the record and flips the record active holding
      // it — access restored by a login whose consent screen never showed
      // it. Re-establishing at the request is the whole of the fix: the
      // re-consent still reactivates the row, and it comes back at exactly
      // what this approval asked for.
      //
      // **Both axes, because both read surfaces filter on both.**
      // `GET /grants` and the security page each list with `state: "active"`
      // and then skip a row whose `properties.status` is not "active", so a
      // row failing either axis is beyond the Disconnect button while the
      // token step below still mints against it.
      //
      // **The lookup is the first fence now, and this is the second.**
      // `findGrantItemId` carries its own `state = 'active'` predicate, so a
      // row sitting at `state: "revoked"` no longer reaches this branch at
      // all — the approval falls through to the fresh insert below and the
      // unreachable row is left where it is. That predicate lives in the
      // store rather than here because the code-flow twin
      // (`projectGrantOnConsent` in `auth-consent.ts`) resolves through the
      // same method and had the identical defect. This read stays because
      // it guards the axis the lookup does not: a row the store admits can
      // still hold `status: "revoked"`, and merging against a withdrawn
      // scope set is what the clause below refuses.
      // `connections/revoked-connection.ts` carries the relationship
      // between the two axes and which disagreements are legitimate.
      //
      // Tested FOR "active" on both rather than against "revoked", which
      // decides the absent and unrecognized cases the safe way round: a
      // state or status this code cannot read is not evidence the user
      // granted anything, so the approval re-establishes at its own request
      // instead of resurrecting scopes nobody can account for.
      const standingScopes =
        existing.state === "active" &&
        existing.properties.status === "active" &&
        Array.isArray(existing.properties.scopes)
          ? (existing.properties.scopes as string[])
          : [];
      const mergedScopes = mergeDeviceApprovalScopes(standingScopes, scopes);
      const updated = await storage.items.update(
        existingItemId,
        {
          properties: {
            scopes: mergedScopes,
            status: "active",
            granted_at: now,
            revoked_at: undefined,
          },
        },
        spaceId,
      );
      if (!("error" in updated)) {
        const metadata = await storage.metadata.get(updated.id);
        await publish({
          type: "updated",
          item: updated,
          metadata,
          spaceId,
        });
        return {
          id: updated.id,
          created: false,
          scopes: mergedScopes,
          spaceId,
        };
      }
    }
  }

  // First-time consent: insert a fresh row.
  const item = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: clientId,
        // Store the consenting auth_user id so cascade revoke
        // (/auth/grants/:id/revoke → revokeTokensForGrant(clientId, userId))
        // and the device-flow terminal step (which needs (clientId, userId)
        // to mint tokens against the plugin's tables) can find the user.
        user_id: consentingUser.id,
        scopes,
        status: "active",
        granted_at: now,
      },
      source,
    },
    spaceId,
  );
  const metadata = await storage.metadata.get(item.id);
  await publish({ type: "created", item, metadata, spaceId });
  return { id: item.id, created: true, scopes, spaceId };
}

/**
 * Note on the signature: the @better-auth/oauth-provider plugin owns
 * token issuance + id_token signing, with its own salt + signer wired
 * through `instance.ts`. `salt` + `oidcSigner` are threaded into
 * `authRoutes` by app.ts for the surfaces this file still serves —
 * device flow uses `salt` for hashing, and `oidcSigner` is reserved
 * for future ID-token-related claims.
 */
export function authRoutes(
  storage: Storage,
  salt: string,
  auth?: MarfaAuth,
  oidcSigner?: OidcSigner,
  /**
   * The shared pending-deletion gate from `account-deletion-guard`. The
   * `POST /auth/sign-in` form handler calls `auth.handler` directly,
   * bypassing the Hono middleware the gate is also mounted as — so the
   * wrapper must run the same check itself to block pending-deletion
   * accounts on the web-form path. Optional so the route still works if
   * it's not wired (the middleware still covers the JSON sign-in paths).
   */
  evaluatePendingDeletion?: EvaluatePendingDeletion,
): Hono<AppEnv> {
  // `salt` is consumed by the device-flow terminal step (hashes
  // minted tokens with the same `hashApiKey(token, salt)` as the
  // bearer middleware). `oidcSigner` is currently unused after the
  // OAuth-protocol delete; kept on the signature for caller stability.
  void oidcSigner;
  const router = new Hono<AppEnv>();
  // The requestable-scope set, shared with the code flow. A snapshot of
  // registry keys cannot validate device requests: `user.*` types are
  // per-space and never enumerate in the static registry, so expanding a
  // wildcard against it silently dropped the scope. The allowlist carries
  // wildcards as first-class literals instead.
  const allowedScopes = new Set(buildAllowedScopes());

  // Per-email throttle on `/auth/forgot-password`: 3 requests per email
  // per hour. Sits on top of the per-IP rate limit — per-IP bounds a
  // noisy client; per-email bounds the address itself so a burst from
  // many IPs can't drown one user's inbox. Counter lives in
  // `storage.rateLimits`: cluster-shared on Postgres, in-process on
  // SQLite single-process self-hosts.
  const forgotPasswordThrottle = new PerEmailThrottle(storage, {
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });

  // Per-email throttle on magic-link sends: one per email per minute. The
  // resend control on the confirmation screen makes asking again a single
  // tap, and an inbox filling with sign-in links is worse than a person
  // waiting a moment. Deliberately silent: the screen says the link is on its
  // way either way, matching the no-enumeration posture the send path already
  // holds, and a countdown would state a rule the server is free to change.
  const magicLinkThrottle = new PerEmailThrottle(storage, {
    family: "magic-link",
    keyPrefix: "magic-link:",
    limit: 1,
    windowMs: 60 * 1000,
  });

  // Per-`user_code` failed-attempt throttle on the device-flow
  // verification form (`POST /auth/device` user-code submission). The
  // per-IP cap in `middleware/rate-limit.ts` bounds a single client
  // guessing codes, but a distributed guesser spreading attempts across
  // many IPs would slip under it. This counter is keyed on the submitted
  // `user_code` itself (independent of IP) and denies once a code has
  // accumulated too many failed lookups — so a brute-force sweep against
  // the short user-code space is capped per code, cluster-wide. Only
  // failed submissions increment; a valid code that advances to consent
  // never touches the counter, so the legitimate flow is unaffected.
  // `PerEmailThrottle` is a generic keyed-counter over
  // `storage.rateLimits`; reused here with a device-code key space.
  const deviceUserCodeThrottle = new PerEmailThrottle(storage, {
    family: "device-user-code",
    keyPrefix: "device-user-code:",
    limit: DEVICE_USER_CODE_MAX_ATTEMPTS,
    windowMs: 60 * 60 * 1000,
  });

  /**
   * Gate `/auth/authorize` on a Better Auth cookie session. End users
   * (not just admins) must be signed in before the consent screen
   * renders or processes a decision. Unauthenticated requests are
   * redirected to `/auth/sign-in` with the original URL preserved as
   * `return_to` so the sign-in flow can pick up where the OAuth flow
   * left off.
   *
   * Returns the active session on success; the caller responds to a
   * `null` return by issuing the redirect (no further work to do).
   */
  async function requireConsentSession(
    c: Context<AppEnv>,
  ): Promise<{ kind: "session"; session: MarfaAuthSession } | Response> {
    if (!auth) {
      // Better-auth isn't mounted on this instance. Without an identity
      // layer the consent screen can't authenticate a user — refuse
      // outright rather than silently accept.
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Consent flow requires the better-auth identity layer to be configured",
      );
    }
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      return { kind: "session", session };
    }
    const url = new URL(c.req.url);
    const returnTo = `${url.pathname}${url.search}`;
    const signInPath = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
    return c.redirect(signInPath, 302);
  }

  // -----------------------------------------------------------------------
  // /auth/tokens (GET / DELETE / PATCH) handlers are not present.
  //
  // Under @better-auth/oauth-provider tokens are short-lived (1h default),
  // rotate on every refresh, and are revoked at the grant level
  // (`/oauth2/revoke` for a single token-in-hand; `/auth/grants/:id/revoke`
  // for the whole grant). Individual-token management had no CLI / SDK /
  // sandbox consumers.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // /auth/grants — typed query into system.connection items
  //
  // The user's "approved apps" surface. Reads system.connection items
  // with kind: app. DELETE flips status → revoked and
  // cascades through revokeGrantTokens to invalidate every token issued
  // under the grant.
  // -----------------------------------------------------------------------

  router.get("/grants", async (c) => {
    // Listing every app a space authorized, and revoking one, are
    // operations on other principals' access — the same tier as the key
    // management routes beside them, not something a narrow member
    // credential does. The space fence below is the second axis: rank
    // says who may act, the space says where.
    const key = requireSpaceAdmin(c);
    // Rank alone is reachable by an app, because the bearer middleware
    // projects the signed-in person's role onto it — and revoking another
    // app's access is exactly the authority a person would want to have been
    // asked about. So the grant has to name it too.
    requireSpacePermission(c, "space.app_grants");
    // A credential carrying a space_id is fenced by the `spaceId`
    // argument below; one without a space would fall through to every
    // space's grants, so that shape needs platform authority (or an
    // explicit platform credential) to reach here.
    if (!key.space_id && !hasPlatformAuthority(key) && !key.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Space scope required for this credential",
      );
    }
    const items = await storage.items.list({
      type: "system.connection",
      state: "active",
      spaceId: key.space_id ?? undefined,
    });
    const grants: {
      id: string;
      kind: string;
      client_id: string;
      scopes: string[];
      status: string;
      granted_at: string;
      last_used_at: string | null;
    }[] = [];
    for (const item of items.data) {
      const props = item.properties;
      if (props.kind !== "app") continue;
      if (props.status !== "active") continue;
      grants.push({
        id: item.id,
        kind: props.kind,
        client_id: typeof props.client_id === "string" ? props.client_id : "",
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        status: typeof props.status === "string" ? props.status : "active",
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }
    return c.json(grants);
  });

  router.delete("/grants/:id", async (c) => {
    // Same two axes as `GET /grants`: space-admin rank to act at all,
    // and the space fence below so only an unbound credential with
    // platform authority may resolve `spaceId` to undefined and address
    // a grant in any space.
    const key = requireSpaceAdmin(c);
    requireSpacePermission(c, "space.app_grants");
    if (!key.space_id && !hasPlatformAuthority(key) && !key.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Space scope required for this credential",
      );
    }
    const spaceId = key.space_id ?? undefined;
    const id = c.req.param("id");
    const item = await storage.items.get(id, spaceId);
    if (item?.type !== "system.connection") {
      throw new MarfaError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    const props = item.properties;
    if (props.kind !== "app") {
      throw new MarfaError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    // Cascade-revoke through the plugin's tables. The system.connection
    // properties carry `client_id` + `user_id` — use those to delete
    // every access + refresh token for this grant and drop the consent
    // row so the next /authorize prompt re-consents.
    const clientId =
      typeof props.client_id === "string" ? props.client_id : undefined;
    const authUserId =
      typeof props.user_id === "string" ? props.user_id : undefined;
    await revokeProjectedGrant(storage, {
      itemId: id,
      properties: props,
      spaceId,
      clientId,
      authUserId,
    });
    auditGrantRevoked(storage, {
      spaceId,
      clientId,
      authUserId,
      grantItemId: id,
      clientIp: c.var.clientIp ?? null,
    });
    return c.body(null, 204);
  });

  // -----------------------------------------------------------------------
  // Sign-in page (HTML) + form-handler wrappers around Better Auth's API
  // -----------------------------------------------------------------------
  //
  // GET /sign-in renders a server-rendered HTML form. It's mounted here
  // (inside authRoutes, which dispatches before the better-auth catch-all
  // in app.ts) so the explicit handler wins.
  //
  // POST /sign-in accepts a form-encoded body and dispatches internally
  // to Better Auth's JSON API (`POST /auth/sign-in/email` for password,
  // `POST /auth/sign-in/magic-link` for magic). Better Auth's response
  // is translated back into a 302 redirect so the no-JavaScript path
  // works — Set-Cookie headers from a successful sign-in are forwarded
  // intact onto the redirect response.

  router.get("/sign-in", async (c) => {
    const url = new URL(c.req.url);
    const modeRaw = url.searchParams.get("mode");
    const mode = modeRaw === "magic" ? "magic" : "password";
    const error = url.searchParams.get("error") ?? undefined;
    const magicLinkSent = url.searchParams.get("sent") === "1";

    // Two paths feed `return_to`:
    //
    //  1. Explicit `return_to` query param. Set by Marfa's own
    //     `requireConsentSession` redirect (the well-behaved
    //    consent-gate path).
    //  2. Bare OAuth params on the URL (`response_type`, `client_id`,
    //     `sig`, etc.) with no `return_to` wrapping. The
    //     @better-auth/oauth-provider plugin's `loginPage` config
    //     redirects unauthenticated users at `/auth/oauth2/authorize`
    //     here by appending the verified-query parameters directly
    //     onto `/auth/sign-in`. Nothing carries params in that shape
    //     through a form submit, so without a hidden `return_to` field
    //     the user lands on `/` after the credential check.
    //     Detect that shape and synthesize `return_to=/auth/authorize?<full original query>`
    //     so the existing form-round-trip path takes over for password,
    //     magic-link, and passkey.
    const email = url.searchParams.get("email");
    let returnTo = validateReturnTo(url.searchParams.get("return_to"));
    if (returnTo === "/" && url.searchParams.has("response_type")) {
      returnTo = synthesizeOauthReturnTo(url.searchParams);
    }

    const html = renderSignInPage({
      mode,
      returnTo,
      error,
      magicLinkSent,
      email,
      allowSignup: auth?.allowSignup ?? false,
      oidcProviderIds: auth?.oidcProviderIds ?? [],
      instanceLinkUrl: await resolveWebAppInstanceLink(
        storage,
        returnTo,
        auth?.baseURL,
      ),
    });
    setNoStore(c);
    return c.html(html);
  });

  router.post("/sign-in", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-in requires the better-auth identity layer to be configured",
      );
    }

    const formData = await c.req.formData();
    const mode = formData.get("mode") === "magic" ? "magic" : "password";
    const returnTo = validateReturnTo(formData.get("return_to"));
    const email = formData.get("email");
    const emailStr = typeof email === "string" ? email.trim() : "";

    const errorRedirect = (errCode: string, modeOverride?: string): Response =>
      c.redirect(
        buildSignInRedirect({
          mode: modeOverride ?? mode,
          returnTo,
          error: errCode,
        }),
        302,
      );

    if (!emailStr) {
      return errorRedirect("missing_field");
    }

    // Pending-deletion gate for the web-form path. The middleware version
    // of this gate only covers better-auth's JSON sign-in endpoints; this
    // wrapper dispatches to `auth.handler` directly (below) and would
    // otherwise sign a pending-deletion account straight in. Run the same
    // shared check here so the form path is guarded too.
    const blocked = evaluatePendingDeletion
      ? await evaluatePendingDeletion(emailStr, c.var.clientIp ?? null)
      : false;
    if (blocked) {
      // Account is pending_deletion. evaluatePendingDeletion already sent
      // the cancel email + wrote the block audit row. Return a response
      // shape INDISTINGUISHABLE from each mode's normal outcome so a
      // pending account can't be enumerated: password -> the same generic
      // invalid-credentials redirect as a wrong password; magic -> the
      // same "we sent a link" response we return on success. Do NOT call
      // `auth.handler`; do NOT log an extra `auth.sign_in.failed` row (the
      // gate's block audit is the record — matching the API-endpoint
      // guard's minimal behavior).
      return mode === "magic"
        ? c.redirect(
            buildSignInRedirect({ mode: "magic", returnTo, sent: true }),
            302,
          )
        : errorRedirect("invalid_credentials");
    }

    if (mode === "magic") {
      // Better-Auth's magic-link plugin validates `callbackURL` against
      // its trusted-origins allowlist and rejects bare relative paths
      // with `{code: "INVALID_CALLBACK_URL"}`, so the upstream gets a
      // same-origin absolute URL either way.
      //
      // What it gets is a landing URL, never `returnTo` itself. The verify
      // endpoint decodes `callbackURL` a second time, after better-call has
      // already decoded it once, so any percent-escape in there is spent
      // twice. `returnTo` on this path is the signed authorize query, and its
      // signature is base64: roughly half of them contain a `+`, which
      // survives the first decode as `%2B` and the second as a literal `+`,
      // which the next parser reads as a space. The signature then fails to
      // match and the user is told their request expired.
      //
      // `signInCompleteUrl` carries the destination base64url-encoded, an
      // alphabet with no `+` and no `%`, so decoding it twice is the same as
      // decoding it once. That holds whether or not the extra decode is ever
      // removed upstream, which is the point: compensating for it by
      // pre-encoding would break the day it is fixed.
      const landingURL = signInCompleteUrl(returnTo, auth.baseURL);
      const upstream = new Request(
        new URL("/auth/sign-in/magic-link", c.req.url),
        {
          method: "POST",
          headers: forwardHeaders(
            c.req.raw.headers,
            { "content-type": "application/json" },
            auth.baseURL,
          ),
          body: JSON.stringify({
            email: emailStr,
            callbackURL: landingURL,
            // Set explicitly. Left unset it defaults to `callbackURL` and has
            // `error=` appended to it, which on the old shape mutated the
            // signed query it was pointing at. Naming the same landing route
            // keeps the failure on a surface that expects it.
            errorCallbackURL: landingURL,
          }),
        },
      );
      // Throttled before dispatch, and a refusal is indistinguishable from a
      // send. Telling the user they asked too soon would be the one response
      // on this surface that varies with something other than their input.
      const sentRedirect = c.redirect(
        buildSignInRedirect({
          mode: "magic",
          returnTo,
          sent: true,
          email: emailStr,
        }),
        302,
      );
      const throttle = await magicLinkThrottle.attempt(emailStr);
      if (!throttle.allowed) return sentRedirect;

      const response = await auth.handler(upstream);
      if (response.ok) return sentRedirect;
      return errorRedirect("magic_send_failed");
    }

    const password = formData.get("password");
    const passwordStr = typeof password === "string" ? password : "";
    if (!passwordStr) {
      return errorRedirect("missing_field");
    }

    const upstream = new Request(new URL("/auth/sign-in/email", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ email: emailStr, password: passwordStr }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Forward every Set-Cookie header from Better Auth onto the redirect
      // response. `Headers.getSetCookie()` returns each cookie as a
      // separate string (Node 18.14+ / undici); fall back to a single
      // header otherwise. Browsers honor multiple Set-Cookie via
      // `headers.append`.
      const redirectHeaders = new Headers({ Location: returnTo });
      const setCookies =
        typeof (
          response.headers as Headers & {
            getSetCookie?: () => string[];
          }
        ).getSetCookie === "function"
          ? (
              response.headers as Headers & {
                getSetCookie: () => string[];
              }
            ).getSetCookie()
          : null;
      if (setCookies && setCookies.length > 0) {
        for (const cookie of setCookies) {
          redirectHeaders.append("set-cookie", cookie);
        }
      } else {
        const single = response.headers.get("set-cookie");
        if (single) redirectHeaders.append("set-cookie", single);
      }
      void storage.audit.log({
        action: "auth.sign_in.success",
        resource_type: "auth_user",
        resource_id: emailStr,
        client_ip: c.var.clientIp ?? null,
        details: { email: emailStr, method: mode },
      });
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    void storage.audit.log({
      action: "auth.sign_in.failed",
      resource_type: "auth_user",
      resource_id: emailStr,
      client_ip: c.var.clientIp ?? null,
      details: {
        email: emailStr,
        method: mode,
        reason: "invalid_credentials",
      },
    });
    return errorRedirect("invalid_credentials");
  });

  // Where a sign-in link lands. Better Auth has already verified the token,
  // created the session and set its cookie by the time it redirects here, so
  // there is nothing left to authenticate: this route decides where the user
  // goes next and records that they arrived.
  //
  // It exists so that `callbackURL` can be a plain URL. See the dispatch in
  // POST /sign-in for why handing the signed authorize query to the plugin
  // directly does not survive the round trip.
  router.get("/sign-in/complete", async (c) => {
    const url = new URL(c.req.url);
    const next = decodeSignInNext(url.searchParams.get("next"));
    setNoStore(c);

    // `error` is Better Auth's, appended to whatever it was given as the
    // error callback. A token that was already spent and one that timed out
    // both arrive as INVALID_TOKEN, so the page names both rather than
    // guessing between them.
    //
    // `new_user_signup_disabled` is the one code worth splitting out: it
    // means the link resolved to an address with no account on an instance
    // where sign-up is off, so the default copy's "send yourself another and
    // it will work" would be a loop rather than a fix.
    const verifyError = url.searchParams.get("error");
    if (verifyError) {
      return c.html(
        renderSignInLinkFailedPage({
          returnTo: next,
          reason:
            verifyError === "new_user_signup_disabled"
              ? "signup_closed"
              : "expired",
          // From the resolved config rather than the request: the request's
          // host is client-supplied and this value is rendered back to the
          // client. Always present rather than optional, on two facts
          // together: `createApp` registers the config middleware ahead of
          // every route, so it runs before any handler, and `authRoutes` is
          // mounted only there and not re-exported from the package entry,
          // so there is no way in that skips it. `hostFromBaseUrl` decides
          // whether the value is one worth naming; a localhost fallback is
          // not.
          host: hostFromBaseUrl(c.var.config.authBaseUrl),
        }),
        400,
      );
    }

    // The session cookie rode in on this request, so the actor is known here
    // and nowhere earlier. The send step cannot audit a sign-in because at
    // that point nobody has signed in; the password path audits inline
    // because its response IS the sign-in.
    const session = auth ? await auth.getSession(c.req.raw.headers) : null;
    if (session) {
      void storage.audit.log({
        action: "auth.sign_in.success",
        resource_type: "auth_user",
        resource_id: session.user.id,
        client_ip: c.var.clientIp ?? null,
        details: { email: session.user.email, method: "magic" },
      });
    }

    return c.redirect(next, 302);
  });

  // Browser logout. The plugin owns the whole of it — validating the id token,
  // matching the return URI, ending the session — and this wrapper adds one
  // thing: a page for the case where the plugin ends the session and then has
  // nowhere to send the person, which it answers with an empty 200. That
  // renders as a blank tab, which reads as a failure even though the logout
  // succeeded. Registered ahead of the catch-all so it sees the response
  // first; every other outcome is passed through untouched.
  router.get("/oauth2/end-session", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-out requires the better-auth identity layer to be configured",
      );
    }
    const upstream = new Request(c.req.url, {
      method: "GET",
      headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
    });
    const response = await auth.handler(upstream);

    const body = response.status === 200 ? await response.clone().text() : null;
    if (body !== null && body.trim().length === 0) {
      const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
      });
      // Same shape as the other wrappers here: getSetCookie keeps multiple
      // cookies separate, since a coalesced header is not a valid cookie.
      const setCookies =
        typeof (response.headers as Headers & { getSetCookie?: () => string[] })
          .getSetCookie === "function"
          ? (
              response.headers as Headers & { getSetCookie: () => string[] }
            ).getSetCookie()
          : null;
      if (setCookies && setCookies.length > 0) {
        for (const cookie of setCookies) headers.append("set-cookie", cookie);
      } else {
        const single = response.headers.get("set-cookie");
        if (single) headers.append("set-cookie", single);
      }
      headers.set("cache-control", "no-store, no-cache, private");
      headers.set("pragma", "no-cache");
      return new Response(renderSignedOutPage(), { status: 200, headers });
    }
    return response;
  });

  router.post("/sign-in/provider/:id", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "OIDC sign-in requires the better-auth identity layer to be configured",
      );
    }
    const providerId = c.req.param("id");
    if (!auth.oidcProviderIds.includes(providerId)) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        `Unknown OIDC provider: ${providerId}`,
      );
    }
    const formData = await c.req.formData();
    const returnTo = validateReturnTo(formData.get("return_to"));

    // A configured provider whose discovery could not be reached is
    // degraded, not missing. Saying so here is what keeps the
    // degradation honest: without it the sign-in page would render the
    // button and then fail generically, which reads as a bug in Marfa
    // rather than an identity provider that is down.
    const availability = auth.oidcStatusOf(providerId);
    if (availability?.status === "unavailable") {
      return c.redirect(
        buildSignInRedirect({
          mode: "password",
          returnTo,
          error: "provider_unavailable",
        }),
        302,
      );
    }

    // Federated providers are registered as social providers and signed
    // in through the core POST /auth/sign-in/social, taking
    // { provider, callbackURL }. The generic-oauth plugin has no
    // /auth/sign-in/oauth2 endpoint of its own. Successful
    // response returns { url, redirect: true } pointing at the
    // provider's authorize URL.
    const upstream = new Request(new URL("/auth/sign-in/social", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({
        provider: providerId,
        // Better-Auth's generic-oauth plugin enforces the same
        // trusted-origins check as magic-link — absolute same-origin
        // URL required.
        callbackURL: new URL(returnTo, auth.baseURL).toString(),
      }),
    });
    const response = await auth.handler(upstream);
    if (!response.ok) {
      // Dispatching went through the handler, which awaits the auth
      // context — so provider availability is settled by now even on the
      // very first request after a boot, when the check above ran too
      // early to know anything. A degraded provider is reported as
      // degraded rather than as a generic OAuth failure.
      const settled = auth.oidcStatusOf(providerId);
      return c.redirect(
        buildSignInRedirect({
          mode: "password",
          returnTo,
          error:
            settled?.status === "unavailable"
              ? "provider_unavailable"
              : "oauth_failed",
        }),
        302,
      );
    }

    const body = (await response.json()) as { url?: string };
    if (typeof body.url === "string" && body.url.length > 0) {
      return c.redirect(body.url, 302);
    }
    return c.redirect(
      buildSignInRedirect({
        mode: "password",
        returnTo,
        error: "oauth_failed",
      }),
      302,
    );
  });

  // -----------------------------------------------------------------------
  // Sign-up page (HTML) + form-handler wrapper
  // -----------------------------------------------------------------------
  //
  // Conditional surface — the GET handler returns 404 when allowSignup
  // is false. The POST wrapper around Better Auth's POST /auth/sign-up/email
  // mirrors the sign-in form-handler shape: form-encoded body, JSON
  // dispatch, Set-Cookie forwarded onto a 302. autoSignIn is enabled
  // upstream so a successful sign-up lands the user on `return_to`
  // already authenticated.

  router.get("/sign-up", (c) => {
    if (!auth?.allowSignup) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
    }
    const url = new URL(c.req.url);
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    const error = url.searchParams.get("error") ?? undefined;
    // Repopulate the fields a server-side error bounce would otherwise wipe.
    // Single-use: read-and-clear, so a fresh visit renders an empty form.
    const values = readAndClearSignupPrefillCookie(c);
    setNoStore(c);
    return c.html(renderSignUpPage({ returnTo, error, values }));
  });

  router.post("/sign-up", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-up requires the better-auth identity layer to be configured",
      );
    }
    if (!auth.allowSignup) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
    }

    const formData = await c.req.formData();
    const returnTo = validateReturnTo(formData.get("return_to"));
    const email = formData.get("email");
    const name = formData.get("name");
    const username = formData.get("username");
    const password = formData.get("password");
    const passwordConfirm = formData.get("password_confirm");
    const emailStr = typeof email === "string" ? email.trim() : "";
    const nameStr = typeof name === "string" ? name.trim() : "";
    const usernameRaw = typeof username === "string" ? username.trim() : "";
    const passwordStr = typeof password === "string" ? password : "";
    const passwordConfirmStr =
      typeof passwordConfirm === "string" ? passwordConfirm : "";

    // `secure` follows the issuer scheme: https on hosted, off for local http
    // dev, matching how the auth cookies decide it.
    const prefillSecure = new URL(auth.baseURL).protocol === "https:";
    const errorRedirect = (errCode: string): Response => {
      // Carry the non-secret fields across the redirect so a bounced form
      // doesn't wipe what the user typed. The password is deliberately left
      // out — the user re-enters it on step 2.
      setSignupPrefillCookie(
        c,
        { email: emailStr, name: nameStr, username: usernameRaw },
        prefillSecure,
      );
      return c.redirect(buildSignUpRedirect({ returnTo, error: errCode }), 302);
    };

    if (
      !emailStr ||
      !nameStr ||
      !usernameRaw ||
      !passwordStr ||
      !passwordConfirmStr
    ) {
      return errorRedirect("missing_field");
    }
    if (passwordStr !== passwordConfirmStr) {
      return errorRedirect("password_mismatch");
    }
    if (passwordStr.length < 8) {
      return errorRedirect("weak_password");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) {
      return errorRedirect("email_invalid");
    }

    // Pre-validate username BEFORE creating an auth_user row. Any
    // failure here means we never call Better Auth — no orphan to roll
    // back. Reserved → invalid → collision, in that order so the user
    // gets the most-specific error.
    const usernameLower = usernameRaw.toLowerCase();
    if (isReservedHandle(usernameLower)) {
      return errorRedirect("handle_reserved");
    }
    if (!isValidHandle(usernameLower)) {
      return errorRedirect("handle_invalid");
    }
    // Hosted-mode is the only path where username makes sense — keys
    // mode has no per-user space. The signup form is gated behind
    // `allowSignup`, which itself is hosted-mode-only in practice.
    if (storage.users) {
      const collision = await storage.users.getByHandle(usernameLower);
      if (collision) {
        return errorRedirect("handle_taken");
      }
    }

    const upstream = new Request(new URL("/auth/sign-up/email", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({
        email: emailStr,
        password: passwordStr,
        name: nameStr,
        // Carry the chosen handle through to the `databaseHooks.user.create`
        // provisioning hook, which reads it off `ctx.body.username` and
        // claims it (falling back to an email-derived handle if it's
        // unusable). Pre-validated above for a friendly synchronous error.
        username: usernameLower,
        // Thread the post-verification target through to Better Auth so the
        // verification email's link returns the user into the app rather
        // than the API root. Without this, Better Auth defaults callbackURL
        // to "/". Mirrors the sign-in and resend handlers.
        callbackURL: new URL(returnTo, auth.baseURL).toString(),
      }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Space + users-row provisioning is owned by the
      // `databaseHooks.user.create.after` hook on the auth instance, so
      // it runs identically for this form path and the programmatic
      // `POST /auth/sign-up/email` path. A provisioning failure rejects
      // the upstream sign-up (the hook rethrows after auditing), so
      // `response.ok` here already implies the space exists. This
      // wrapper only translates the result into the no-JS redirect flow.
      void storage.audit.log({
        action: "auth.sign_up",
        resource_type: "auth_user",
        resource_id: emailStr,
        client_ip: c.var.clientIp ?? null,
        details: { email: emailStr, username: usernameLower },
      });
      // autoSignIn=true on the auth instance means the response carries
      // a session cookie — UNLESS `requireEmailVerification: true` is
      // set, in which case better-auth returns 200 with
      // `{ token: null, user }` and no Set-Cookie. We branch on the
      // cookie presence: if absent, redirect to the verify-email page
      // so the user can watch for the inbox arrival; if present, land
      // them on `return_to` already authenticated.
      const setCookies =
        typeof (
          response.headers as Headers & {
            getSetCookie?: () => string[];
          }
        ).getSetCookie === "function"
          ? (
              response.headers as Headers & {
                getSetCookie: () => string[];
              }
            ).getSetCookie()
          : null;
      const singleCookie = response.headers.get("set-cookie");
      const cookies =
        setCookies && setCookies.length > 0
          ? setCookies
          : singleCookie
            ? [singleCookie]
            : [];

      if (cookies.length === 0) {
        // Verification-required path. Redirect to the verify-email
        // page with the email pre-filled and return_to threaded
        // through so the user lands on their original destination
        // after clicking the link.
        const params = new URLSearchParams();
        params.set("email", emailStr);
        params.set("return_to", returnTo);
        return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
      }

      const redirectHeaders = new Headers({ Location: returnTo });
      for (const cookie of cookies) {
        redirectHeaders.append("set-cookie", cookie);
      }
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    // Map Better Auth's error response shape to our user-facing codes.
    // Better Auth returns 422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL when
    // the email is taken, and 400 with code ROLE-validation when password
    // is invalid. Read the body once to discriminate.
    let errorCode = "signup_failed";
    try {
      const body = (await response.json()) as { code?: string };
      if (body.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        errorCode = "email_exists";
      } else if (body.code?.toLowerCase().includes("password")) {
        errorCode = "weak_password";
      } else if (body.code?.toLowerCase().includes("email")) {
        errorCode = "email_invalid";
      }
    } catch {
      // Fall through to the generic signup_failed code.
    }
    return errorRedirect(errorCode);
  });

  // -----------------------------------------------------------------------
  // Self-serve API keys (HTML console)
  // -----------------------------------------------------------------------
  //
  // Cookie-authenticated key management for a space owner. The data plane
  // (`/items`, `/keys`, …) stays strictly bearer-only; this surface lives
  // in the `/auth/*` zone where the Better Auth session cookie is the
  // authenticator. It's the self-serve path a freshly-onboarded hosted
  // user takes to mint their first long-lived `marfa_k1_` key after
  // sign-up + verification, with no pre-existing bearer token to bootstrap
  // from. Keys minted here are `space_admin` (the space owner) scoped to
  // the user's own space.

  // Resolve the signed-in user's marfa profile (carrying space_id) from
  // their Better Auth session. Null when the account has no Marfa space
  // (keys-mode self-host, or an unprovisioned edge case).
  async function resolveSessionUser(session: MarfaAuthSession) {
    if (!storage.users) return null;
    return storage.users.getByAuthUserId(session.user.id);
  }

  // The space's keys, mapped to the console's view shape.
  async function listSpaceKeys(spaceId: string): Promise<KeysPageKey[]> {
    const all = await storage.keys.list();
    return all
      .filter((k) => k.space_id === spaceId)
      .map((k) => ({
        id: k.id,
        label: k.label,
        source: k.source,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
      }));
  }

  const noSpacePage = (session: MarfaAuthSession): string =>
    renderKeysPage({
      email: session.user.email,
      keys: [],
      notice: {
        kind: "error",
        text: "No Marfa space is provisioned for this account yet.",
      },
    });

  router.get("/keys", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    const userRow = await resolveSessionUser(gated.session);
    if (!userRow?.space_id) {
      return c.html(noSpacePage(gated.session));
    }
    const keys = await listSpaceKeys(userRow.space_id);
    return c.html(renderKeysPage({ email: gated.session.user.email, keys }));
  });

  router.post("/keys", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    const userRow = await resolveSessionUser(gated.session);
    if (!userRow?.space_id) {
      return c.html(noSpacePage(gated.session));
    }
    const spaceId = userRow.space_id;

    const formData = await c.req.formData();
    const labelRaw = formData.get("label");
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
    if (!label) {
      const keys = await listSpaceKeys(spaceId);
      return c.html(
        renderKeysPage({
          email: gated.session.user.email,
          keys,
          notice: { kind: "error", text: "A label is required." },
        }),
      );
    }
    // The label becomes the key's `source`, and a `source` is not inert:
    // `oauth:<connection-id>` is read as proof that a caller IS that
    // connection's own credential, by the connection proxy, the
    // inbound-webhook and the leased-token routes alike. All three treat
    // it as an alternative to space-admin rank, so a member who could
    // name one here would be handed the connection's upstream access
    // token to proxy through, the ability to mint its webhook secrets and
    // the ability to issue leases on it, for any connection in their own
    // space.
    //
    // The two sibling mint routes both call this. This one did not, and
    // the reserved list is the whole defense — nothing legitimate is
    // turned away, because genuine runtime credentials are minted at
    // the storage layer by the runtime and never through an HTTP
    // route.
    if (isReservedCredentialSource(label)) {
      const keys = await listSpaceKeys(spaceId);
      return c.html(
        renderKeysPage({
          email: gated.session.user.email,
          keys,
          notice: {
            kind: "error",
            text: 'That label is reserved. Labels cannot start with "oauth:", "integration:" or "runtime-" — those name a connection\'s own credential.',
          },
        }),
      );
    }

    // The permissions the owner ticked, in the `<type>:<verb>` scope grammar.
    // Only valid scopes survive; the key is scoped to exactly these.
    //
    // A content-category literal is dropped rather than admitted, and this
    // drop OUTLIVES the withholding that put the others beside it there.
    // `content:read` and `content:write` are requestable now — the consent
    // screens describe them and tell the two levels apart — but nothing on
    // THIS form learned to. `pickedTypeScopeLevel` below reads the ticked
    // type scopes and knows nothing of the kind, so an admitted literal
    // mints a key that misdescribes itself: the category projects the global
    // wildcard, so the key writes every non-system type in the space, while
    // the owner is told it reaches none of their content and it is minted
    // with no edge permissions.
    //
    // Not an escalation, and not reachable by anyone using the page: the
    // picker emits `<type>:<verb>` and nothing else, so arriving here takes
    // a hand-crafted post, and the same reach is already askable honestly
    // through full access. It stays because a credential whose own summary
    // is wrong is worse than one that was never minted. Removing it means
    // teaching the summary the kind first.
    const scopes = formData
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string")
      // The content drop is a standing limitation recorded elsewhere. The
      // withheld drop is what stops a hand-crafted post to this form from
      // naming a capability, and the reason has changed rather than gone: it
      // used to be that such a literal granted nothing, so admitting one was
      // merely untidy. `space.keys` now opens all four keys doors, so a
      // form post that slipped one through would be a grant nobody ticked on
      // a consent screen — which is the one thing the capability family exists
      // to prevent.
      .filter(
        (s) =>
          isValidScope(s) && !isContentScope(s) && !isWithheldFromAllowlist(s),
      );
    // Full access carries its own grant and needs no ticked scopes, so it is
    // resolved before the "pick at least one" guard rather than after it.
    const wantsFullAccess = formData.get("full_access") === "on";
    if (scopes.length === 0 && !wantsFullAccess) {
      const keys = await listSpaceKeys(spaceId);
      return c.html(
        renderKeysPage({
          email: gated.session.user.email,
          keys,
          notice: {
            kind: "error",
            text: "Choose at least one thing this key can do.",
          },
        }),
      );
    }
    // "Full access" asks for a credential that can fill the owner's whole
    // space — seeding it, migrating into it, restoring a backup. That case had
    // no self-serve route at all before, so it had to be handed a
    // platform-minted key by an operator, which is the dependency the
    // space-admin role exists to remove. It asks at the owner's OWN role;
    // `canGrantRole` at the mint is what stops it exceeding them.
    const fullAccess = wantsFullAccess;
    const requestedRole: MarfaRole = fullAccess ? userRow.role : "member";

    // Full access is its own grant over every content type, so it sets the
    // content level outright rather than being read back off the ticked set.
    const contentLevel: "read" | "write" | null = fullAccess
      ? "write"
      : pickedTypeScopeLevel(scopes);

    const typePermissions = fullAccess
      ? { [GLOBAL_TYPE_WILDCARD]: "write" as const }
      : scopesToTypePermissions(scopes);

    const edgePermissions = selfServeEdgePermissions(scopes, contentLevel);
    const accessSummary = fullAccess
      ? "read and write everything in your space"
      : contentLevel === "write"
        ? "read and write your content"
        : contentLevel === "read"
          ? "read your content"
          : "reach none of your content";

    const rawKey = `marfa_k1_${randomBytes(32).toString("hex")}`;
    const stored = await storage.keys.create(
      {
        label,
        // The label doubles as the key's `source` — the provenance stamped
        // onto items written with it, surfaced back to the owner.
        source: label,
        // A self-serve key carries only the permissions the owner picked, and
        // never more authority than the owner has. `canGrantRole` is the same
        // ceiling `POST /keys` enforces, so the lattice has one implementation
        // rather than a second one that can drift out of step with it.
        role: canGrantRole(userRow.role, requestedRole)
          ? requestedRole
          : "member",
        is_platform: false,
        type_permissions: typePermissions,
        // Edges are the substance of the data model, so a key that cannot
        // write them cannot seed, migrate or restore a space — which is what
        // left an account owner unable to fill their own space at all. This is
        // narrower than it looks: an edge mutation dual-gates on the source
        // item's type as well as the edge type, so a key scoped to notes can
        // still only build edges out of notes.
        edge_permissions: edgePermissions,
      },
      hashApiKey(rawKey, salt),
      spaceId,
    );
    void storage.audit.log({
      space_id: spaceId,
      action: "key.create",
      resource_type: "key",
      resource_id: stored.id,
      client_ip: c.var.clientIp ?? null,
      details: { source: "auth_console" },
    });

    const keys = await listSpaceKeys(spaceId);
    return c.html(
      renderKeysPage({
        email: gated.session.user.email,
        keys,
        // Shown once, in this response body — never via a redirect query.
        newKey: rawKey,
        newKeyLabel: label,
        newKeyAccess: accessSummary,
      }),
    );
  });

  router.post("/keys/:id/revoke", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    const userRow = await resolveSessionUser(gated.session);
    if (!userRow?.space_id) {
      return c.html(noSpacePage(gated.session));
    }
    const spaceId = userRow.space_id;
    const id = c.req.param("id");

    // Space-scope the revoke: only act on a key in the caller's own
    // space. A miss is silently treated as already-gone so cross-space
    // probes can't enumerate key ids.
    const target = await storage.keys.get(id);
    const matched = target?.space_id === spaceId;
    if (matched) {
      await storage.keys.revoke(id);
      void storage.audit.log({
        space_id: spaceId,
        action: "key.revoke",
        resource_type: "key",
        resource_id: id,
        client_ip: c.var.clientIp ?? null,
        details: { source: "auth_console" },
      });
    }

    const keys = await listSpaceKeys(spaceId);
    return c.html(
      renderKeysPage({
        email: gated.session.user.email,
        keys,
        notice: matched
          ? { kind: "success", text: "Key revoked." }
          : { kind: "error", text: "Key not found." },
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Email verification
  // -----------------------------------------------------------------------
  //
  // Three observable surfaces:
  //   - GET /auth/verify-email?token=…&return_to=…  — token path:
  //     forwards to better-auth's verify-email endpoint which validates
  //     the token, stamps `email_verified=true`, and (because we don't
  //     pass `callbackURL`) returns a JSON body. We render success or
  //     failure as our themed page, forwarding any Set-Cookie better-auth
  //     issued (currently none on the verify endpoint, but
  //     forward-compatible with future better-auth changes).
  //   - GET /auth/verify-email?email=…&return_to=… — pending path:
  //     no token, just landed from a sign-up redirect. Renders the
  //     "check your inbox" page with a resend form. Optional `?sent=1`
  //     swaps to the success-banner variant for resend confirmations.
  //   - POST /auth/verify-email/resend — calls better-auth's
  //     send-verification-email endpoint. Idempotent at the user level
  //     (idempotency key per-token threaded through to audit on the
  //     transport hook). Redirects back with `?sent=1` regardless of
  //     whether the address actually exists, to avoid email enumeration.

  router.get("/verify-email", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Email verification requires the better-auth identity layer to be configured",
      );
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email");
    // The verification email's link carries the post-verify target as
    // `callbackURL` (Better Auth's param — an absolute, same-origin URL such
    // as the OAuth authorize endpoint); our own redirects use `return_to`
    // (relative). Accept either, normalizing a same-origin callbackURL down
    // to a relative path so the success page's Continue link carries the user
    // onward (e.g. back into the OAuth flow and on to the app) rather than to
    // the API root at `/`.
    const callbackParam = url.searchParams.get("callbackURL");
    let callbackReturnTo: string | null = null;
    if (callbackParam) {
      try {
        const cb = new URL(callbackParam, auth.baseURL);
        if (cb.origin === new URL(auth.baseURL).origin) {
          callbackReturnTo = `${cb.pathname}${cb.search}`;
        }
      } catch {
        callbackReturnTo = null;
      }
    }
    const returnTo = validateReturnTo(
      url.searchParams.get("return_to") ?? callbackReturnTo,
    );
    const sent = url.searchParams.get("sent");
    setNoStore(c);

    if (!token) {
      return c.html(
        renderVerifyEmailPage({
          state: sent === "1" ? "resent" : "pending",
          email,
          returnTo,
        }),
      );
    }

    // Token path. Forward to better-auth's GET /auth/verify-email
    // (we omit `callbackURL` so it returns a JSON body rather than
    // a redirect; we render our own success/failure UI).
    const upstreamUrl = new URL("/auth/verify-email", c.req.url);
    upstreamUrl.searchParams.set("token", token);
    const upstream = new Request(upstreamUrl, {
      method: "GET",
      headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Audit the successful email verification. resource_id is the
      // token prefix (correlation handle) since we don't have the
      // user_id at this layer.
      void storage.audit.log({
        action: "auth.email.verified",
        resource_type: "auth_user",
        resource_id: token.slice(0, 12),
        client_ip: c.var.clientIp ?? null,
        details: { token_prefix: token.slice(0, 12) },
      });
      // Forward any Set-Cookie better-auth issued onto our response
      // (forward-compatible — the current 1.6.x verify-email doesn't
      // mint a session, but we don't want to silently drop it if a
      // future bump does).
      const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
      });
      const setCookies =
        typeof (response.headers as Headers & { getSetCookie?: () => string[] })
          .getSetCookie === "function"
          ? (
              response.headers as Headers & { getSetCookie: () => string[] }
            ).getSetCookie()
          : null;
      if (setCookies && setCookies.length > 0) {
        for (const cookie of setCookies) headers.append("set-cookie", cookie);
      } else {
        const single = response.headers.get("set-cookie");
        if (single) headers.append("set-cookie", single);
      }
      // No-store on the success render too; the URL carries a
      // single-use token and shouldn't sit in history caches.
      headers.set("cache-control", "no-store, no-cache, private");
      headers.set("pragma", "no-cache");
      return new Response(
        renderVerifyEmailPage({ state: "success", returnTo }),
        { status: 200, headers },
      );
    }

    // Failure path. One plain "that link didn't work" screen with an inline
    // resend — the specific reason (expired / used / malformed) doesn't
    // change what the user does next.
    return c.html(
      renderVerifyEmailPage({
        state: "failure",
        email,
        returnTo,
      }),
    );
  });

  router.post("/verify-email/resend", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Email verification requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const email = formData.get("email");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const emailStr = typeof email === "string" ? email.trim() : "";

    if (!emailStr) {
      const params = new URLSearchParams({ return_to: returnTo });
      return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
    }

    // Forward to better-auth's POST /auth/send-verification-email.
    // Soft-fail on errors — we redirect with `?sent=1` regardless so
    // an attacker can't probe whether an address has an account.
    const upstream = new Request(
      new URL("/auth/send-verification-email", c.req.url),
      {
        method: "POST",
        headers: forwardHeaders(
          c.req.raw.headers,
          { "content-type": "application/json" },
          auth.baseURL,
        ),
        body: JSON.stringify({
          email: emailStr,
          // Resolve to an absolute URL — Better-Auth's verify-email
          // plugin validates callbackURL against its trusted-origins
          // allowlist and rejects bare relative paths.
          callbackURL: new URL(returnTo, auth.baseURL).toString(),
        }),
      },
    );
    try {
      await auth.handler(upstream);
    } catch {
      // Swallow — the redirect carries `?sent=1` regardless to keep
      // the soft-fail invariant.
    }

    const params = new URLSearchParams();
    params.set("email", emailStr);
    params.set("return_to", returnTo);
    params.set("sent", "1");
    return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
  });

  // -----------------------------------------------------------------------
  // Forgot password + reset
  // -----------------------------------------------------------------------
  //
  // Surfaces:
  //   - GET  /auth/forgot-password           — render the email form
  //   - POST /auth/forgot-password           — soft-fail dispatch to
  //     better-auth's `request-password-reset`. Per-email throttled
  //     (3/hour) AND per-IP throttled (via existing rate-limit
  //     middleware's `pathLimits`). Always 302s to the `sent` state
  //     regardless of whether the address exists, to avoid email
  //     enumeration.
  //   - GET  /auth/reset-password?token=…    — render the new-password
  //     form. Token validity is checked on POST (not GET) — cheap, and
  //     better-auth-style callback redirects have already been bypassed
  //     by our hook constructing the email URL directly.
  //   - POST /auth/reset-password            — validate fields, dispatch
  //     to better-auth's `reset-password`, render success or failure.

  router.get("/forgot-password", (c) => {
    const url = new URL(c.req.url);
    const error = url.searchParams.get("error") as
      "rate_limited" | "email_not_configured" | null;
    const sent = url.searchParams.get("sent") === "1";
    const email = url.searchParams.get("email");
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    setNoStore(c);
    return c.html(
      renderForgotPasswordPage({
        state: error ? "error" : sent ? "sent" : "form",
        email,
        returnTo,
        errorCode: error ?? undefined,
      }),
    );
  });

  router.post("/forgot-password", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const emailRaw = formData.get("email");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const emailStr =
      typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";

    // Empty / malformed email — render the form again with the value
    // erased; no point dispatching upstream.
    if (!emailStr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) {
      const params = new URLSearchParams({ return_to: returnTo });
      return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
    }

    // Per-email throttle. The rate-limit middleware also caps per-IP;
    // this is the parallel cap for the email itself.
    const throttle = await forgotPasswordThrottle.attempt(emailStr);
    if (!throttle.allowed) {
      const params = new URLSearchParams({
        email: emailStr,
        return_to: returnTo,
        error: "rate_limited",
      });
      return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
    }

    // Dispatch to better-auth. We swallow errors — the soft-fail
    // success render is the canonical path regardless of upstream
    // outcome (no enumeration). The `sendResetPassword` hook itself
    // logs failures and writes to the audit trail.
    try {
      const upstream = new Request(
        new URL("/auth/request-password-reset", c.req.url),
        {
          method: "POST",
          headers: forwardHeaders(
            c.req.raw.headers,
            { "content-type": "application/json" },
            auth.baseURL,
          ),
          body: JSON.stringify({ email: emailStr }),
        },
      );
      await auth.handler(upstream);
    } catch {
      // Soft-fail.
    }

    // Audit every reset-request attempt regardless of upstream outcome.
    // Captures the email + IP for rate-monitoring; operators can
    // correlate with `auth.password_reset.completed` to spot abandoned
    // flows.
    void storage.audit.log({
      action: "auth.password_reset.requested",
      resource_type: "auth_user",
      resource_id: emailStr,
      client_ip: c.var.clientIp ?? null,
      details: { email: emailStr },
    });

    const params = new URLSearchParams({
      email: emailStr,
      return_to: returnTo,
      sent: "1",
    });
    return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
  });

  router.get("/reset-password", (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    setNoStore(c);

    // No token means the user landed here without clicking a link.
    // Send them to forgot-password to start over.
    if (!token) {
      return c.redirect("/auth/forgot-password", 302);
    }

    return c.html(renderResetPasswordPage({ state: "form", token, returnTo }));
  });

  router.post("/reset-password", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const token = formData.get("token");
    const password = formData.get("password");
    const passwordConfirm = formData.get("password_confirm");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const tokenStr = typeof token === "string" ? token : "";
    const passwordStr = typeof password === "string" ? password : "";
    const passwordConfirmStr =
      typeof passwordConfirm === "string" ? passwordConfirm : "";

    // Form-side validation. Re-render with an in-form banner so the
    // user doesn't lose the in-progress reset.
    const renderForm = (
      formError: "missing_field" | "password_mismatch" | "weak_password",
    ): Response =>
      c.html(
        renderResetPasswordPage({
          state: "form",
          token: tokenStr,
          returnTo,
          formError,
        }),
      );

    if (!tokenStr || !passwordStr || !passwordConfirmStr) {
      return renderForm("missing_field");
    }
    if (passwordStr !== passwordConfirmStr) {
      return renderForm("password_mismatch");
    }
    if (passwordStr.length < 8) {
      return renderForm("weak_password");
    }

    // Dispatch to better-auth's POST /auth/reset-password.
    const upstream = new Request(new URL("/auth/reset-password", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ newPassword: passwordStr, token: tokenStr }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Audit the successful reset. resource_id is the token prefix as
      // a correlation handle — user_id isn't available at this layer.
      void storage.audit.log({
        action: "auth.password_reset.completed",
        resource_type: "auth_user",
        resource_id: tokenStr.slice(0, 12),
        client_ip: c.var.clientIp ?? null,
        details: { token_prefix: tokenStr.slice(0, 12) },
      });
      // Success — render the success page. The user has no active
      // session now and must sign in fresh.
      return c.html(renderResetPasswordPage({ state: "success", returnTo }));
    }

    // One plain "that link didn't work" screen with a way to request a
    // fresh link — the specific reason doesn't change the next step.
    return c.html(renderResetPasswordPage({ state: "failure" }));
  });

  // -----------------------------------------------------------------------
  // Security page + session/grant revocation
  // -----------------------------------------------------------------------
  //
  // Surfaces:
  //   - GET  /auth/security                — auth-gated. Lists the
  //     user's connected apps + active sessions with revoke buttons.
  //   - POST /auth/grants/:id/revoke       — form-friendly counterpart
  //     to the existing API DELETE /auth/grants/:id. The HTML page
  //     forms POST here; redirects back to /auth/security with a
  //     notice on success.
  //   - POST /auth/sessions/:id/revoke     — form-friendly per-session
  //     revoke. Looks up the session id in the user's list-sessions
  //     output, extracts its token, forwards to better-auth's
  //     POST /auth/revoke-session.
  //   - POST /auth/sessions/sign-out-all   — revokes every session
  //     (including current). Forwards to better-auth's
  //     POST /auth/revoke-sessions, then redirects to /auth/sign-in.

  router.get("/security", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    // requireConsentSession throws when auth is undefined, so reaching
    // this point guarantees auth is defined — narrow it for TS.
    if (!auth) throw new Error("unreachable: auth defined after gated");

    const sessionUser = gated.session.user;
    const currentSessionId = gated.session.session.id;

    // 1. Forward GET /auth/list-sessions internally to get this
    //    user's active sessions. Cookies thread through so
    //    better-auth resolves to the right user.
    let sessions: SecurityPageSession[] = [];
    try {
      const listReq = new Request(new URL("/auth/list-sessions", c.req.url), {
        method: "GET",
        headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
      });
      const listRes = await auth.handler(listReq);
      if (listRes.ok) {
        const data = (await listRes.json()) as {
          id: string;
          createdAt: string | Date;
          updatedAt: string | Date;
          ipAddress?: string | null;
          userAgent?: string | null;
        }[];
        sessions = data.map((s) => ({
          id: s.id,
          created_at:
            typeof s.createdAt === "string"
              ? s.createdAt
              : s.createdAt.toISOString(),
          last_active_at:
            typeof s.updatedAt === "string"
              ? s.updatedAt
              : s.updatedAt.toISOString(),
          is_current: s.id === currentSessionId,
          ip_address: s.ipAddress ?? null,
          user_agent: s.userAgent ?? null,
        }));
      }
    } catch {
      // Soft-fail — render the page without the sessions list rather
      // than 500. Operators see the underlying log if it's a real
      // outage.
    }

    // 2. List grants for this user's space. In keys mode (no
    //    storage.users), grants are space-less and we list them
    //    that way; this matches the pattern in /auth/grants and the
    //    existing DELETE handler.
    let spaceId: string | undefined;
    if (storage.users) {
      // Lookup by Better Auth user id (the canonical bridge).
      const userRow = await storage.users.getByAuthUserId(sessionUser.id);
      spaceId = userRow?.space_id;
    }
    const grantItems = await storage.items.list({
      type: "system.connection",
      state: "active",
      spaceId,
    });
    // Per-grant client-name lookup from the plugin's auth_oauth_client
    // table. Worst-case N small queries; for the page-load scale this
    // is fine. If the page grows hot, swap for a single IN-clause
    // batch read.
    const grants: SecurityPageGrant[] = [];
    for (const item of grantItems.data) {
      const props = item.properties;
      if (props.kind !== "app") continue;
      if (props.status !== "active") continue;
      const clientId =
        typeof props.client_id === "string" ? props.client_id : "";
      const clientName =
        clientId && typeof storage.oauthProvider?.getClientName === "function"
          ? ((await storage.oauthProvider.getClientName(clientId)) ?? clientId)
          : clientId;
      grants.push({
        id: item.id,
        client_name: clientName,
        client_id: clientId,
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }

    // 3. Optional flash notice from `?notice=...`.
    const url = new URL(c.req.url);
    const notice = parseNotice(url.searchParams.get("notice"));

    return c.html(
      renderSecurityPage({
        email: sessionUser.email,
        grants,
        sessions,
        notice,
      }),
    );
  });

  // Form-friendly grant revoke. Mirrors the DELETE /auth/grants/:id
  // logic but renders a redirect back to /auth/security with a flash
  // notice instead of a 204 body.
  router.post("/grants/:id/revoke", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    const sessionUser = gated.session.user;

    let spaceId: string | undefined;
    if (storage.users) {
      // Lookup by Better Auth user id (the canonical bridge).
      const userRow = await storage.users.getByAuthUserId(sessionUser.id);
      spaceId = userRow?.space_id;
    }
    const id = c.req.param("id");
    const item = await storage.items.get(id, spaceId);
    if (item?.type !== "system.connection") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    const props = item.properties;
    if (props.kind !== "app") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    // Cascade-revoke via plugin tables (same logic as DELETE /grants/:id).
    const clientId =
      typeof props.client_id === "string" ? props.client_id : undefined;
    const authUserId =
      typeof props.user_id === "string" ? props.user_id : undefined;
    try {
      await revokeProjectedGrant(storage, {
        itemId: id,
        properties: props,
        spaceId,
        clientId,
        authUserId,
      });
    } catch (err) {
      // The cascade refused, so nothing was revoked and the record still
      // describes the access the app really has. Say so: a redirect
      // reading "App access revoked" would be the one thing worse than
      // the failure itself.
      log("error", "security page: grant revoke failed", {
        client_id: clientId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect("/auth/security?notice=grant_revoke_failed", 302);
    }
    auditGrantRevoked(storage, {
      spaceId,
      clientId,
      authUserId,
      grantItemId: id,
      clientIp: c.var.clientIp ?? null,
    });
    return c.redirect("/auth/security?notice=grant_revoked", 302);
  });

  router.post("/sessions/:id/revoke", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    if (!auth) throw new Error("unreachable: auth defined after gated");
    const id = c.req.param("id");
    const currentSessionId = gated.session.session.id;
    if (id === currentSessionId) {
      // Refuse to revoke the current session through this path —
      // the user should use Sign out everywhere instead, which
      // signs them out cleanly. Defense-in-depth: the form button
      // for the current session is rendered as disabled.
      return c.redirect("/auth/security?notice=cannot_revoke_current", 302);
    }
    // Look up the session by id in the user's list to extract the
    // token (better-auth's revoke endpoint takes a token, not an id).
    let token: string | null = null;
    try {
      const listReq = new Request(new URL("/auth/list-sessions", c.req.url), {
        method: "GET",
        headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
      });
      const listRes = await auth.handler(listReq);
      if (listRes.ok) {
        const data = (await listRes.json()) as {
          id: string;
          token: string;
        }[];
        const match = data.find((s) => s.id === id);
        if (match) token = match.token;
      }
    } catch {
      return c.redirect("/auth/security?notice=session_revoke_failed", 302);
    }
    if (!token) {
      return c.redirect("/auth/security?notice=session_not_found", 302);
    }
    const revokeReq = new Request(new URL("/auth/revoke-session", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ token }),
    });
    const revokeRes = await auth.handler(revokeReq);
    if (!revokeRes.ok) {
      return c.redirect("/auth/security?notice=session_revoke_failed", 302);
    }
    return c.redirect("/auth/security?notice=session_revoked", 302);
  });

  router.post("/sessions/sign-out-all", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    if (!auth) throw new Error("unreachable: auth defined after gated");
    const revokeReq = new Request(new URL("/auth/revoke-sessions", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
    });
    const revokeRes = await auth.handler(revokeReq);
    // Regardless of upstream outcome, the current session is now
    // cooked (or about to be). Redirect to /auth/sign-in.
    void revokeRes;
    return c.redirect("/auth/sign-in", 302);
  });

  // -----------------------------------------------------------------------
  // Passkey enroll
  // -----------------------------------------------------------------------
  //
  // GET /auth/passkey/enroll — auth-gated HTML page that runs the
  // WebAuthn registration ceremony in the browser. Better-auth's
  // passkey plugin provides the raw endpoints (`/passkey/generate-
  // register-options`, `/passkey/verify-registration`, etc.); this
  // page just stitches the ceremony around them.
  //
  // Passkey sign-in (the auth side of the same plugin) is exposed
  // as a button on `/auth/sign-in` that calls
  // `MarfaPasskey.signIn()` from the same static script.

  router.get("/passkey/enroll", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    return c.html(renderPasskeyEnrollPage({ email: gated.session.user.email }));
  });

  // -----------------------------------------------------------------------
  // Device Authorization Grant (RFC 8628)
  // -----------------------------------------------------------------------
  //
  // Three observable surfaces:
  //   - POST /auth/device (JSON)   — initiate a flow; returns device_code +
  //     user_code + verification_uri. The CLI / Swift SDK call this.
  //   - POST /auth/device (form)   — the user submits their user_code from
  //     the verification page; if valid, redirect to /auth/device/consent.
  //   - POST /auth/device/token    — polled by the client until the user
  //     approves; returns the standard OAuth token response on success.
  //   - GET /auth/device           — verification HTML form (optionally
  //     pre-filled via ?user_code=…).
  //   - GET /auth/device/consent?user_code=… — consent screen, gated on a
  //     better-auth session (redirects to /auth/sign-in if absent).
  //   - POST /auth/device/consent  — approve/deny submission.

  // Shared device-flow init handler. Reachable from JSON callers (the
  // Marfa CLI / SDK shape) and from RFC 8628 §3.1 form-encoded callers
  // (the protocol-canonical shape). Both produce the same device-code
  // envelope.
  const initDeviceFlow = async (
    c: Context,
    clientId: string | null,
    rawScope: string,
  ): Promise<Response> => {
    const scope = rawScope.trim();
    if (!clientId || !scope) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "client_id and scope are required",
      );
    }
    // Client lookup reads the plugin's `auth_oauth_client` table.
    const client = await storage.oauthProvider?.getClient(clientId);
    if (!client) {
      throw new MarfaError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    // A client that did not register the device grant may not run it.
    //
    // The plugin enforces this on its own token paths, through
    // `clientAllowsGrant` inside `validateClientCredentials`. The device
    // flow is Marfa's own state machine and reaches none of that, which is
    // why the check has to be restated here rather than inherited — and
    // why it has to read `grant_types` the same way, or the platform holds
    // two answers to one question.
    if (!clientAllowsDeviceGrant(client.grantTypes)) {
      throw new MarfaError(
        ErrorCode.INVALID_CLIENT,
        "This client is not registered for the device grant",
      );
    }
    const requestedScopes = scope.split(" ").filter(Boolean);
    if (requestedScopes.length === 0) {
      throw new MarfaError(
        ErrorCode.INVALID_SCOPE,
        "No valid scopes requested",
      );
    }
    // The first ceiling, on a pass of its own: what the platform offers at
    // all. The stored grant is the literal set and consent approves it
    // verbatim, so a scope that slipped through here would be granted
    // unseen — any disallowed scope refuses the whole request.
    //
    // Nothing that writes may run above this loop. Initiation is
    // unauthenticated, and the catch-up below is a persistent write to a
    // stored registration row. Interleaving the two lets a caller who has
    // proved nothing move stored state with input this server has not
    // accepted: the request still refuses, and the row it was refused
    // against keeps the widening. That row is also what this client is
    // given when it omits `scope` entirely, so the next consent screen
    // would open pre-ticked with what the refused request named.
    for (const requested of requestedScopes) {
      if (!allowedScopes.has(requested)) {
        throw new MarfaError(
          ErrorCode.INVALID_SCOPE,
          `Scope not available: ${requested}`,
        );
      }
    }
    // The second ceiling: what this client registered for. The plugin
    // resolves it as `client.scopes ?? opts.scopes` on the
    // authorization-code path; this path never read it, so a client
    // registered for one scope could open a device flow asking for every
    // scope on the platform, with only a person reading the consent screen
    // carefully in the way.
    //
    // It refuses rather than narrowing, which is the opposite of what the
    // authorize surface does and deliberately so. There, the error rides a
    // redirect the app may never render and a human is stood in front of
    // it, so narrowing is what lets a stale request still succeed. Here the
    // response goes straight back to the machine that made the request,
    // which can read it. Handing back a device code for less than was asked
    // for, without saying so, turns a two-line fix at the client into a
    // token that quietly does not do what the client was built for.
    //
    // Refusing is only defensible while the ceiling being compared against
    // is current, and the stored row is not: it is a registration-time
    // snapshot of an allowlist that moves whenever the type registry does.
    // So it gets the same catch-up the authorize surface performs, before
    // the loop below compares against it. Without that, a client registered
    // for a bundle-published wildcard was refused a scope beneath it,
    // terminally, for a registration that plainly covered it.
    //
    // Making the comparison below coverage-aware instead is the repair that
    // looks right and is not. It would leave this surface reading a ceiling
    // one way while every other reader of the same row reads it exactly, and
    // two surfaces answering one question two different ways is what the
    // comment in `narrowAuthorizeScopes` exists to prevent. Breadth belongs
    // in what gets written, not in what gets compared.
    const bundles = getPermissionBundles();
    const clientCeiling = await catchUpClientScopeCeiling({
      storage,
      clientId,
      requested: requestedScopes,
      ceiling: client.scopes,
      bundleScopes: bundlePublishedScopes(bundles),
      surface: "device",
    });
    for (const requested of requestedScopes) {
      if (clientCeiling !== null && !clientCeiling.includes(requested)) {
        throw new MarfaError(
          ErrorCode.INVALID_SCOPE,
          `Scope not registered for this client: ${requested}`,
        );
      }
    }
    // **There was a third check here, and it is retired rather than
    // weakened.** It refused any scope only an off-by-default bundle offers,
    // because the approval screen confirmed a scope list with no per-scope
    // toggle: on a screen with no tick there was nothing for "leaving it
    // alone grants nothing" to mean, so approving handed over in one click
    // exactly what the flag exists to withhold.
    //
    // That screen has toggles now, and it reads the same rule the authorize
    // screen reads. So the premise the refusal rested on is gone, and
    // keeping it would be the harm rather than the guard: the CLI signs in
    // through this flow and nothing else, and the MCP server has no consent
    // surface at all — it reads the token the CLI stored. Refusing here
    // would leave both permanently unable to hold a capability, which is a
    // lockout dressed as least privilege.
    //
    // Withholding now happens where a person can act on it: the scope
    // arrives unticked, and `POST /auth/device/consent` grants the ticked
    // set rather than the requested one.

    const deviceCodeRaw = generateToken(DEVICE_CODE_PREFIX);
    const deviceCodeHash = sha256(deviceCodeRaw);
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString();
    const intervalSeconds = DEVICE_CODE_DEFAULT_INTERVAL_SECONDS;

    await storage.oauth.createDeviceCode({
      deviceCodeHash,
      userCode,
      clientId,
      scope: requestedScopes.join(" "),
      expiresAt,
      intervalSeconds,
    });

    const verificationBase = auth?.baseURL ?? new URL(c.req.url).origin;
    const verificationUri = `${verificationBase}/auth/device`;
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
    return c.json({
      device_code: deviceCodeRaw,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: intervalSeconds,
    });
  };

  router.post("/device", async (c) => {
    const contentType = c.req.header("content-type") ?? "";

    // -------------------- JSON init --------------------
    // Marfa's own CLI / SDK use this shape; not RFC-mandated but
    // operationally convenient.
    if (contentType.includes("application/json")) {
      let body: { client_id?: unknown; scope?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "JSON body required");
      }
      const clientId =
        typeof body.client_id === "string" ? body.client_id : null;
      const scope = typeof body.scope === "string" ? body.scope : "";
      return initDeviceFlow(c, clientId, scope);
    }

    // -------------------- Form-encoded --------------------
    // Two distinct operations share the form-encoded surface:
    //
    //   1. **Init** — RFC 8628 §3.1. Body carries `client_id` (+
    //      `scope`). Any client following the spec literally lands
    //      here.
    //   2. **User-code submission** — Marfa's verification form. Body
    //      carries `user_code`.
    //
    // Disambiguate by inspecting the body. A request with neither
    // field falls through to the user-code branch and gets the
    // existing `missing_code` redirect — same behavior as before.
    const formData = await c.req.formData();
    const formClientId = formData.get("client_id");
    if (typeof formClientId === "string" && formClientId !== "") {
      const formScopeRaw = formData.get("scope");
      const scope = typeof formScopeRaw === "string" ? formScopeRaw : "";
      return initDeviceFlow(c, formClientId, scope);
    }

    // -------------------- Form submit user_code --------------------
    const submittedRaw = formData.get("user_code");
    const submitted =
      typeof submittedRaw === "string"
        ? submittedRaw.trim().toUpperCase().replace(/\s+/g, "")
        : "";
    if (!submitted) {
      return c.redirect(`/auth/device?error=missing_code`, 302);
    }
    const normalized = normalizeUserCode(submitted);

    // Per-`user_code` failed-attempt throttle (independent of IP).
    // Register every failed submission against the submitted code and
    // refuse once the code crosses the cap, so a distributed guesser
    // can't sweep the user-code space by rotating IPs under the per-IP
    // limit. A failure that crosses the cap — and any later attempt on
    // an already-poisoned code — surfaces `too_many_attempts`. A valid
    // code advances to consent below WITHOUT incrementing, so the
    // legitimate one-shot flow never trips the throttle.
    const failAttempt = async (errorCode: string): Promise<Response> => {
      const throttle = await deviceUserCodeThrottle.attempt(normalized);
      if (!throttle.allowed) {
        return c.redirect(
          `/auth/device?error=too_many_attempts&user_code=${encodeURIComponent(submitted)}`,
          302,
        );
      }
      return c.redirect(
        `/auth/device?error=${errorCode}&user_code=${encodeURIComponent(submitted)}`,
        302,
      );
    };

    const row = await storage.oauth.findDeviceCodeByUserCode(normalized);
    if (!row) {
      return failAttempt("invalid_code");
    }
    if (row.status !== "pending") {
      return failAttempt("already_resolved");
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return failAttempt("expired_code");
    }
    return c.redirect(
      `/auth/device/consent?user_code=${encodeURIComponent(normalized)}`,
      302,
    );
  });

  router.get("/device", (c) => {
    const url = new URL(c.req.url);
    const rawCode = url.searchParams.get("user_code") ?? "";
    const error = url.searchParams.get("error") ?? undefined;

    // If the URL carries a user_code (i.e. the user followed
    // `verification_uri_complete`) and there's no error to surface,
    // jump straight to the consent screen — skipping the manual
    // "Continue" click on a form that's already pre-filled. The
    // consent route 302s to /auth/sign-in if there's no session yet
    // (preserving the user_code via return_to), so this is safe —
    // no auto-approval, just one fewer tap. Falls through to the form
    // if the code is empty/garbled or an error is being surfaced.
    const normalized = normalizeUserCode(
      rawCode.trim().toUpperCase().replace(/\s+/g, ""),
    );
    if (!error && normalized && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) {
      return c.redirect(
        `/auth/device/consent?user_code=${encodeURIComponent(normalized)}`,
        302,
      );
    }
    setNoStore(c);
    return c.html(renderDevicePage({ prefilled: rawCode, error }));
  });

  router.get("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;
    const url = new URL(c.req.url);
    const userCodeRaw = url.searchParams.get("user_code") ?? "";
    const userCode = normalizeUserCode(userCodeRaw.trim().toUpperCase());
    if (!userCode) {
      return c.redirect("/auth/device?error=missing_code", 302);
    }
    const row = await storage.oauth.findDeviceCodeByUserCode(userCode);
    if (!row) {
      return c.redirect("/auth/device?error=invalid_code", 302);
    }
    if (row.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.redirect(`/auth/device?error=expired_code`, 302);
    }
    // Client lookup reads the plugin's auth_oauth_client table.
    const client = await storage.oauthProvider?.getClient(row.client_id);
    if (!client) {
      throw new MarfaError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }

    // Render the same consent template as /auth/authorize. The submit
    // target is /auth/device/consent (not /auth/authorize), and the
    // hidden user_code field replaces the OAuth code-flow params.
    //
    // The stored literals render as they will be granted: a wildcard is
    // one row covering its whole pattern, never expanded against the
    // static registry — expansion showed concrete types the grant does
    // not enumerate, and dropped `user.*` entirely because runtime
    // types are not in the registry to expand against.
    const parsedScopes = row.scopes
      .map(parseScope)
      .filter(
        (s): s is NonNullable<ReturnType<typeof parseScope>> => s !== null,
      );
    // The same copy `/auth/authorize` renders, from the same function. Two
    // maps stood here and agreed with that screen about types while
    // contradicting it about metadata and wildcards, so which answer a
    // person got depended on which screen the device flow had put them on.
    //
    // It also reverses the precedence this loop carried: curated copy now
    // wins over the type registry's description. That is what the other
    // screen has always shown, and the registry's is written for a developer
    // reading API docs rather than for an owner approving a grant.
    const descriptions = buildScopeDescriptions(parsedScopes);

    setNoStore(c);
    return c.html(
      renderDeviceConsentScreen({
        clientName: client.name ?? client.clientId,
        scopes: parsedScopes,
        userCode,
        descriptions,
        // The screen decides its own ticks from these, the same way the
        // authorize screen does. Passed rather than read inside the
        // renderer so both surfaces resolve the bundle set at their own
        // call site, which is the standing convention for this pair.
        bundles: getPermissionBundles(),
      }),
    );
  });

  router.post("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;

    const formData = await c.req.formData();
    const userCodeRaw = formData.get("user_code");
    const userCode =
      typeof userCodeRaw === "string"
        ? normalizeUserCode(userCodeRaw.trim().toUpperCase())
        : "";
    const decision = formData.get("decision");
    if (!userCode || (decision !== "approve" && decision !== "deny")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "user_code and decision are required",
      );
    }
    const row = await storage.oauth.findDeviceCodeByUserCode(userCode);
    if (!row) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Unknown user_code");
    }
    if (row.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.redirect(`/auth/device?error=expired_code`, 302);
    }

    // The ticked set, intersected with what the device asked for.
    //
    // **An intersection rather than a substitution**, because this form is a
    // browser surface and its fields are whoever's browser it is to edit. A
    // hand-edited submission must not grant an app more than the client
    // requested or more than the screen displayed, and the stored row is what
    // every later reader treats as the request.
    //
    // **Nothing ticked is a denial**, the same rule the authorize screen
    // applies to a zero-scope accept and for the same reason: a grant of
    // nothing is not a grant, and recording one leaves a projection and a
    // consent row standing for an app that can do nothing with them. It also
    // keeps the two surfaces answering one question the same way.
    const requestedScopeSet = new Set(row.scopes);
    const approvedScopes = [
      ...new Set(
        formData
          .getAll("scopes")
          .filter((v): v is string => typeof v === "string")
          .filter((v) => requestedScopeSet.has(v)),
      ),
    ];

    if (decision === "deny" || approvedScopes.length === 0) {
      await storage.oauth.denyDeviceCode(row.id);
      setNoStore(c);
      return c.html(renderDeviceDecisionPage({ approved: false }));
    }

    // Approve: upsert the system.connection projection and flip the
    // device-code row.
    //
    // The upsert resolves the projection, reads it, and writes it back
    // active with this request's scopes — a read-modify-write on the same
    // record the consent decision, the silent re-authorization, and the
    // revoke path all write, so it takes the same lock they do. Left
    // outside it, a revoke running concurrently can land its whole
    // cascade between this read and this write, and the write then puts
    // the grant back to active with `revoked_at` cleared: an end state
    // neither ordering of the two user actions would produce.
    //
    // **The binding is inside the lock too, and that is the half that was
    // missing.** The revoke's sweep is `deleteDeviceCodesForGrant`, keyed on
    // `connection_item_id`, and it runs inside this same lock. With the bind
    // outside it, a revoke could take the lock the moment the grant write
    // released it, run its entire cascade past a code whose grant reference
    // was still null — matching nothing — and release; the bind then attached
    // that code to a grant that had just been revoked. Revocation deletes
    // device codes rather than flipping their status, so the `status =
    // 'pending'` predicate the bind runs under was still satisfied and the
    // write succeeded.
    //
    // Inside, the two orderings are the only two outcomes. Approval first:
    // the code is bound before the sweep runs, so the sweep finds and deletes
    // it. Revoke first: the cascade completes against nothing, and the
    // approval that follows creates a fresh grant and binds to that.
    const { grant, ok } = await withConsentLock(
      row.client_id,
      sessionResult.session.user.id,
      async () => {
        const provider = storage.oauthProvider;
        const created = await createUserAppGrant(
          storage,
          sessionResult.session.user,
          row.client_id,
          approvedScopes,
          "marfa/oauth/device",
        );
        const bound = await storage.oauth.approveDeviceCode(
          row.id,
          created.id,
          approvedScopes,
        );
        // The plugin's half of the grant. This surface never passes through
        // the plugin's consent endpoint, so without this write a device
        // grant had a projection and no consent row, and neither consent
        // check (the plugin's exact-membership skip, Marfa's coverage check
        // behind it) could see it: every later browser authorize for the
        // same app rendered consent afresh. Written with the projection's
        // merged set, because the projection is the grant and the row
        // mirrors it: a row standing alone after a failed projection write
        // is narrowed here to what the person just approved, which is less
        // access rather than more, and the browser asks again for the rest.
        // Inside the lock so a revoke cannot land between the two halves,
        // and only once the code is bound: an approval that
        // lost to a deny in another tab is told it did not take effect, and
        // must not leave a row that answers the next browser authorize with
        // a code and no screen. The trade: a throw from this write now lands
        // after the bind, so the device gets its tokens on the next poll
        // while the person sees an error and no `auth.grant.created` row is
        // written. That is a projection without a row, the state this
        // change repairs, and the next approval repairs it again; the other
        // order wrote a row for an approval that never took effect.
        if (bound && provider && typeof provider.upsertConsent === "function") {
          await provider.upsertConsent({
            clientId: row.client_id,
            authUserId: sessionResult.session.user.id,
            referenceId: created.spaceId ?? null,
            scopes: created.scopes,
          });
        }
        return { grant: created, ok: bound };
      },
    );
    if (!ok) {
      // Race: someone else flipped it in between. Surface as already-resolved.
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    void storage.audit.log({
      space_id: grant.spaceId ?? null,
      action: "auth.grant.created",
      resource_type: "oauth_grant",
      resource_id: row.client_id,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: row.client_id,
        user_id: sessionResult.session.user.id,
        // Three halves now, because two of them can differ in each
        // direction and none alone answers the question an operator brings
        // to this row. `scopes` is what this device asked for. The screen
        // offers those as toggles, so `approved_scopes` is what the person
        // actually ticked, which can be narrower — a narrowing is otherwise
        // invisible, and it is the whole reason the initiation refusal could
        // be retired. And an approval merges into the standing grant rather
        // than replacing it, so `resulting_scopes` is the record afterwards,
        // which can be wider than either. On a first-time approval where
        // nothing was unticked, all three are the same list.
        scopes: row.scopes,
        approved_scopes: approvedScopes,
        resulting_scopes: grant.scopes,
        grant_item_id: grant.id,
        source: "device",
        // `created: false` means re-consent (item already existed) —
        // useful for the operator trail to distinguish first-time
        // approvals from re-approvals of an existing grant.
        created: grant.created,
      },
    });
    setNoStore(c);
    return c.html(renderDeviceDecisionPage({ approved: true }));
  });

  router.post("/device/token", async (c) => {
    const formData = await c.req.formData();
    const grantType = formData.get("grant_type");
    const deviceCodeRaw = formData.get("device_code");
    const clientId = formData.get("client_id");

    if (
      grantType !== DEVICE_CODE_GRANT_TYPE ||
      typeof deviceCodeRaw !== "string" ||
      typeof clientId !== "string"
    ) {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "grant_type, device_code, and client_id are required",
        },
        400,
      );
    }

    const row = await storage.oauth.findDeviceCodeByHash(sha256(deviceCodeRaw));
    if (row?.client_id !== clientId) {
      return c.json(
        { error: "invalid_grant", error_description: "Unknown device_code" },
        400,
      );
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json(
        { error: "expired_token", error_description: "device_code expired" },
        400,
      );
    }

    if (row.status === "denied") {
      return c.json(
        {
          error: "access_denied",
          error_description: "User denied the request",
        },
        400,
      );
    }

    // A code is exchanged once. The client stops polling on success per RFC
    // 8628 §3.5, so a second poll is a code that has left the device: a log,
    // a shared terminal, a replayed request. `invalid_grant` per RFC 6749
    // §5.2, the same answer a revoked grant gets, so the two are not told
    // apart from outside.
    if (row.status === "redeemed") {
      log("info", "device token refused: code already exchanged", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    if (row.status === "pending") {
      // Slow-down detection: if the client polled inside the interval
      // window, return slow_down + bumped interval.
      const now = new Date();
      if (row.last_polled_at) {
        const elapsed = now.getTime() - new Date(row.last_polled_at).getTime();
        if (elapsed < row.interval_seconds * 1000) {
          await storage.oauth.markDeviceCodePolled(row.id, now.toISOString());
          return c.json(
            {
              error: "slow_down",
              error_description: "Polling too fast — wait longer",
            },
            400,
          );
        }
      }
      await storage.oauth.markDeviceCodePolled(row.id, now.toISOString());
      return c.json(
        {
          error: "authorization_pending",
          error_description: "User has not yet approved",
        },
        400,
      );
    }

    // status === "approved" — issue tokens against the connection grant.
    if (!row.connection_item_id) {
      // The foreign key is `onDelete: "set null"`, so hard-purging the grant
      // item through `DELETE /items/:id/purge` leaves an approved code
      // pointing at nothing. That is a grant that no longer exists rather
      // than an invariant this code can vouch for, and the caller gets the
      // same refusal a revoked grant gets.
      log("info", "device token refused: grant no longer exists", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    // Terminal token issuance. The plugin owns the canonical token
    // storage tables (`auth_oauth_access_token`,
    // `auth_oauth_refresh_token`); we mint into them directly so the
    // bearer middleware resolves device-flow tokens identically to
    // authorization-code-flow tokens. The hash function (`hashApiKey`)
    // is the same one the plugin's `storeTokens.hash` is wired to.
    //
    // **Prefix-stripped hash, matching the plugin convention.** The
    // plugin strips `prefix.opaqueAccessToken` / `prefix.refreshToken`
    // BEFORE calling its hasher (`index.mjs:419` for issuance,
    // `:858`/`:2266` for lookup). To stay symmetric — so the bearer
    // middleware finds device-flow tokens by computing the same hash
    // — we strip here too. Without this, device-flow access tokens
    // would 401 on every request because the middleware's lookup hash
    // wouldn't match the stored one.
    const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
    const accessBare = accessRaw.slice(ACCESS_TOKEN_PREFIX.length);
    const accessHash = hashApiKey(accessBare, salt);

    // Resolve the grant to extract space_id + approved scopes.
    // Type check is defense-in-depth: connection_item_id comes from a
    // server-controlled row, but a future approve-handler change could
    // stamp a wrong id and silently mint an orphan token without it.
    const deviceGrant = await storage.items.get(row.connection_item_id);
    if (deviceGrant?.type !== "system.connection") {
      throw new Error(
        "Device-flow grant resolves to non-system.connection item (projection drift?)",
      );
    }
    const grantProps = deviceGrant.properties;

    // Both lifecycle axes, before anything is minted against the record.
    //
    // Revocation leaves the scope list verbatim on the row it flips, so
    // every scope check below a revoked grant still passes and the poll
    // hands back a working pair for the rest of the device code's TTL, and
    // where `offline_access` was approved, a refresh token minted after the
    // revoke cascade already ran, which nothing subsequently invalidates. A
    // bounded window becomes indefinite access through ordinary rotation,
    // while the user's security page reports the app as disconnected the
    // whole time.
    //
    // Revocation now deletes the codes too, so in the ordinary case this
    // never fires. It is kept for the same reason the authorization-code
    // guard is: the deletion alone is a sweep, and a sweep has a window.
    // A code bound to the grant after the sweep passed over it survives
    // one and misses the other, and the approval that binds it runs
    // outside the consent lock the revoke holds.
    //
    // **Both axes, because a grant needs both to be reachable.** `state` is
    // the item's lifecycle axis and `properties.status` is the type's own,
    // and `connections/revoked-connection.ts` carries why the two cannot
    // legitimately disagree. Both read surfaces require both before showing
    // a grant to its owner, so a row active on one axis alone is one no
    // person can revoke through the interface built for revoking it, and
    // minting against it is what makes that state worth having.
    //
    // Tested FOR "active" rather than against "revoked": a state this code
    // cannot read is not evidence the user granted anything.
    //
    // `invalid_grant`, per RFC 6749 §5.2, and the same answer the
    // authorization-code guard gives for the same fact on the code path.
    if (deviceGrant.state !== "active" || grantProps.status !== "active") {
      log("info", "device token refused: grant revoked", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    const grantScopes = Array.isArray(grantProps.scopes)
      ? (grantProps.scopes as string[])
      : [];
    const grantClientId =
      typeof grantProps.client_id === "string"
        ? grantProps.client_id
        : row.client_id;
    const grantUserId =
      typeof grantProps.user_id === "string" ? grantProps.user_id : undefined;
    if (!grantUserId) {
      // System.connection projection lands the user_id property; if it
      // hasn't yet, fail loud rather than silently issue an orphan token.
      throw new Error(
        "Device-flow grant missing user_id property (projection not run?)",
      );
    }
    if (typeof storage.oauthProvider?.mintTokenPair !== "function") {
      throw new Error("oauthProvider store not wired");
    }

    // What this device asked for, and never the whole standing grant.
    //
    // The two used to be the same set: an approval overwrote the record
    // with the device request, so reading the record back was reading the
    // request. Now that an approval merges into a standing grant instead of
    // replacing it, the record can hold scopes this device never asked for
    // and its screen never showed: the browser's own consent, for the same
    // client and user. Minting from the record would hand a CLI the web
    // app's access on the strength of a login, and hand it a refresh token
    // whenever the browser had once asked to stay signed in.
    //
    // Filtered against the grant rather than taken raw, because the record
    // is still the authority and a device code outlives its approval by up
    // to the rest of its TTL. A narrowing on the consent screen inside that
    // window rewrites the scope list, and the poll that follows reads the
    // rewritten one, so it cannot hand back a scope that was dropped. The
    // intersection is the only reading that holds both ends: never more
    // than was asked for, never more than the scope list reaches.
    //
    // **Revocation is not this filter's job and never was.** Filtering
    // against a revoked record would still mint, because revocation leaves
    // the scope list intact. The lifecycle guard above is what refuses that
    // grant outright, and it runs before this line so the intersection is
    // only ever computed against a grant that is live on both axes.
    //
    // **Computed on effective permissions, because a coverage test per
    // literal is not an intersection.** Scope resolution gives an exact type
    // id precedence over a wildcard spanning it, so coverage is not
    // reflexive on a pinned set: `["core.*:write", "core.note:read"]` does
    // not cover `core.*:write`, a literal it contains. A device asking for a
    // wildcard alongside a narrower pin was therefore issued the pin alone,
    // though the user had approved both and the grant reached both, and it
    // was handed a narrower `scope` string rather than an error.
    // `intersectDeviceScopes` is the merge's sibling and takes the minimum
    // where that takes the maximum; the reasoning is at the function.
    const issuedScopes = intersectDeviceScopes(row.scopes, grantScopes);

    // `offline_access` is what buys a refresh token, here as everywhere else.
    //
    // The library issues one only for a grant carrying the scope, and its
    // rotation is reached only for tokens it issued that way: rotating
    // revokes the presented token and links the replacement into the same
    // family, which is what lets a replayed token be spotted and the chain
    // terminated. This route writes its own rows and so sits outside that,
    // and minting unconditionally produced a refresh token nothing could
    // ever rotate — a credential with no expiry and no way to go stale, on
    // grants belonging to devices signed in once and left alone.
    //
    // Issuing only on `offline_access` closes it by removing the credential
    // rather than by reimplementing rotation, and it makes the two paths
    // agree: a client that wants to stay signed in asks for the scope, and
    // the consent screen already renders it as a line the user approves.
    const staysSignedIn = issuedScopes.includes("offline_access");
    const refreshRaw = staysSignedIn
      ? generateToken(REFRESH_TOKEN_PREFIX)
      : undefined;
    const refreshHash =
      refreshRaw === undefined
        ? undefined
        : hashApiKey(refreshRaw.slice(REFRESH_TOKEN_PREFIX.length), salt);

    // Spend the code before minting against it. The flip is conditional on
    // the row still reading approved, so two polls racing for one code see
    // one winner and the other is refused rather than both minting a pair.
    // Before rather than after the mint, because a code spent by a mint that
    // then failed costs the device a restart, while a mint that succeeded
    // ahead of a flip that then failed would have handed out a pair the
    // code could still be exchanged for again.
    const spent = await storage.oauth.redeemDeviceCode(row.id);
    if (!spent) {
      log("info", "device token refused: code exchanged concurrently", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    await storage.oauthProvider.mintTokenPair({
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
      clientId: grantClientId,
      authUserId: grantUserId,
      referenceId: deviceGrant.space_id ?? null,
      scopes: issuedScopes,
      accessTtlMs: ACCESS_TOKEN_TTL_MS,
    });

    // Stamp last_used_at on the underlying grant — best-effort.
    await stampOAuthGrantLastUsed(
      storage,
      row.connection_item_id,
      deviceGrant.space_id ?? undefined,
    );

    return c.json({
      access_token: accessRaw,
      ...(refreshRaw !== undefined && { refresh_token: refreshRaw }),
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: issuedScopes.join(" "),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Device Authorization Grant — local helpers
// ---------------------------------------------------------------------------

/**
 * RFC 8628 device-code grant type literal.
 *
 * Exported because four places had their own copy of this string and a
 * typo in any one of them fails in a way that reads as a protocol
 * disagreement rather than a spelling mistake.
 */
export const DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Whether a client's registered `grant_types` admit the device grant.
 *
 * An absent or empty registration means `authorization_code` and nothing
 * else, per RFC 7591 §2, which is also how the OAuth plugin reads it in
 * `clientAllowsGrant`. Reading it as "declared nothing, so allow anything"
 * would be more permissive here than on every path the plugin owns, and a
 * platform that answers one question two ways is the shape this lane spent
 * its time removing.
 */
export function clientAllowsDeviceGrant(
  grantTypes: readonly string[] | null,
): boolean {
  const declared =
    grantTypes && grantTypes.length > 0 ? grantTypes : ["authorization_code"];
  return declared.includes(DEVICE_CODE_GRANT_TYPE);
}

const DEVICE_CODE_PREFIX = "marfa_dc_";
const DEVICE_CODE_TTL_MS = 600_000; // 10 minutes
const DEVICE_CODE_DEFAULT_INTERVAL_SECONDS = 5;
/** Failed `user_code` submissions allowed per code before the device
 *  verification form refuses further attempts. Defends the short
 *  user-code space against a distributed brute force that would slip
 *  under the per-IP rate limit. */
const DEVICE_USER_CODE_MAX_ATTEMPTS = 5;

/** Alphabet for user_code — restricted to avoid I/O/0/1/U/V ambiguity.
 *  24 chars × 8 positions = ~110 billion. Plenty for 10-min TTL. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTWXYZ23456789";
/** 8 alphanum chars, hyphenated XXXX-XXXX. */
function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars: string[] = [];
  for (const b of bytes) {
    const idx = b % USER_CODE_ALPHABET.length;
    chars.push(USER_CODE_ALPHABET.charAt(idx));
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Normalize a user-submitted code to the storage shape: uppercase,
 *  hyphenated XXXX-XXXX. Accepts the user typing without the hyphen. */
function normalizeUserCode(input: string): string {
  const stripped = input.replace(/-/g, "").toUpperCase();
  if (stripped.length !== 8) return input.toUpperCase();
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/** Build a redirect URL back to the sign-up page with error + return_to. */
/**
 * Short-lived flash cookie carrying a bounced sign-up's non-secret field
 * values across the POST-redirect-GET round-trip, so a server-side error the
 * form can't catch client-side (a taken username, an already-registered email)
 * doesn't wipe what the user typed. Scoped to `/auth/sign-up`, HttpOnly,
 * single-use. Never carries the password.
 */
const SIGNUP_PREFILL_COOKIE = "marfa.signup_prefill";
const SIGNUP_PREFILL_PATH = "/auth/sign-up";

interface SignupPrefill {
  email?: string;
  name?: string;
  username?: string;
}

/**
 * Set the sign-up prefill cookie before an error redirect. The value is
 * base64url(JSON) — cookie-safe and compact. It is deliberately NOT signed:
 * the payload is the user's own non-secret form input, the cookie is HttpOnly
 * so page scripts can't read it, and every value is HTML-escaped at render, so
 * tampering can only change what a user sees pre-filled in their own form.
 * `secure` follows the issuer URL (https on hosted, off for local http dev),
 * matching the auth cookies.
 */
function setSignupPrefillCookie(
  c: Context<AppEnv>,
  fields: SignupPrefill,
  secure: boolean,
): void {
  const encoded = Buffer.from(JSON.stringify(fields), "utf8").toString(
    "base64url",
  );
  setCookie(c, SIGNUP_PREFILL_COOKIE, encoded, {
    path: SIGNUP_PREFILL_PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure,
    // Just long enough for the redirect round-trip — a one-shot prefill, not
    // durable state.
    maxAge: 300,
  });
}

/**
 * Read and clear the sign-up prefill cookie. Single-use: the clear runs
 * whenever the cookie is present, so a later plain visit to `/auth/sign-up`
 * renders an empty form. Malformed values are ignored.
 */
function readAndClearSignupPrefillCookie(
  c: Context<AppEnv>,
): SignupPrefill | undefined {
  const raw = getCookie(c, SIGNUP_PREFILL_COOKIE);
  if (!raw) return undefined;
  deleteCookie(c, SIGNUP_PREFILL_COOKIE, { path: SIGNUP_PREFILL_PATH });
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? v : undefined;
    return {
      email: str(obj.email),
      name: str(obj.name),
      username: str(obj.username),
    };
  } catch {
    return undefined;
  }
}

function buildSignUpRedirect(params: {
  returnTo: string;
  error?: string;
}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  if (params.returnTo && params.returnTo !== "/") {
    search.set("return_to", params.returnTo);
  }
  const query = search.toString();
  return `/auth/sign-up${query ? `?${query}` : ""}`;
}

/**
 * Absolute URL of the landing route a sign-in link returns to, carrying its
 * destination in `next`.
 *
 * `next` is base64url rather than percent-encoded because the value handed to
 * Better Auth's `callbackURL` is decoded twice on the way back, and base64url
 * has no character that a decode changes. Percent-encoding here would be spent
 * on the first decode and mangled by the second, which is the whole defect
 * this route exists to route around.
 */
function signInCompleteUrl(returnTo: string, baseURL: string): string {
  const next = Buffer.from(returnTo, "utf8").toString("base64url");
  return new URL(`/auth/sign-in/complete?next=${next}`, baseURL).toString();
}

/**
 * Recover the destination from a landing-route `next`, or `/` when there
 * isn't a usable one.
 *
 * Re-validated rather than trusted. `next` reaches us off a URL, so it is an
 * open-redirect vector like any other, and it has been out of our hands since
 * the email was sent. `validateReturnTo` is the same gate the value passed on
 * the way in.
 */
function decodeSignInNext(raw: string | null): string {
  if (!raw) return "/";
  try {
    return validateReturnTo(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return "/";
  }
}

/** Build a redirect URL back to the sign-in page with the right query
 *  shape (mode, error, sent, return_to). All values are encoded. */
function buildSignInRedirect(params: {
  mode: string;
  returnTo: string;
  error?: string;
  sent?: boolean;
  /** Carried so the confirmation screen can resend without asking for the
   *  address a second time. */
  email?: string;
}): string {
  const search = new URLSearchParams();
  if (params.mode === "magic") search.set("mode", "magic");
  if (params.error) search.set("error", params.error);
  if (params.sent) search.set("sent", "1");
  if (params.email) search.set("email", params.email);
  if (params.returnTo && params.returnTo !== "/") {
    search.set("return_to", params.returnTo);
  }
  const query = search.toString();
  return `/auth/sign-in${query ? `?${query}` : ""}`;
}

/** Map the `?notice=` query param on /auth/security to the flash banner
 *  the page renders. Unknown codes return `undefined` (no banner). */
function parseNotice(
  raw: string | null,
): { kind: "success" | "error"; text: string } | undefined {
  if (!raw) return undefined;
  const messages: Record<string, { kind: "success" | "error"; text: string }> =
    {
      grant_revoked: {
        kind: "success",
        text: "App access revoked. The app will no longer be able to access your data.",
      },
      grant_not_found: {
        kind: "error",
        text: "That app was already revoked or no longer exists.",
      },
      grant_revoke_failed: {
        kind: "error",
        text: "Couldn't revoke that app's access, so nothing was changed. Try again in a moment.",
      },
      session_revoked: {
        kind: "success",
        text: "Session signed out. The device will need to sign in again.",
      },
      session_not_found: {
        kind: "error",
        text: "That session was already signed out or no longer exists.",
      },
      session_revoke_failed: {
        kind: "error",
        text: "Couldn't sign out that session. Try again in a moment.",
      },
      cannot_revoke_current: {
        kind: "error",
        text: "Use Sign out everywhere to revoke the current session.",
      },
    };
  return messages[raw];
}
