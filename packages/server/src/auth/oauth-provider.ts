/**
 * @better-auth/oauth-provider plugin wiring.
 *
 * The OAuth protocol surface is owned by the @better-auth/oauth-provider
 * plugin; endpoints land under `/auth/oauth2/*` via Better Auth's
 * catch-all (basePath `/auth`).
 *
 * Three coupled pieces in this file:
 *   1. `buildAllowedScopes(...)` — enumerates the Marfa scope grammar at
 *      instance-construction time from the type / edge registries so the
 *      plugin's allowlist accepts every concrete typed scope
 *      (`core.note:read`, `edge.parent-of:write`, …). Custom types
 *      registered at runtime require a server restart to surface
 *      (acceptable tradeoff; documented).
 *   2. `buildOauthProviderPlugin(...)` — constructs the plugin with
 *      opaque tokens hashed via Marfa's `hashApiKey(t, salt)`, the
 *      `marfa_at_` / `marfa_rt_` prefixes, space binding via
 *      `clientReference` + `postLogin.consentReferenceId`, and OIDC
 *      custom claims for profile + email + space_id.
 *   3. `buildOauthProjectionPlugin(...)` — the before-hook that
 *      defends against refresh-token replay by pre-emptively revoking
 *      access tokens when a stale refresh is detected.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createHmac } from "node:crypto";
import {
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
  expandBundlesToScopes,
} from "@withmarfa/shared";
import type { PermissionBundle } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { getPermissionBundles } from "../config.js";
import {
  CLIENT_CREDENTIALS_DEFAULT_SCOPES,
  dcrDefaultScopes,
} from "./mint-ceiling.js";
import { log } from "../middleware/logger.js";

/**
 * Minimal context shape we read off `hooks.after` matchers + handlers.
 * Mirrors the slice of Better Auth's `HookEndpointContext` we touch —
 * `path` is widened to `string | undefined` to match the library's
 * type (some internal paths leave it unset).
 */
interface HookCtxLite {
  path?: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  context?: {
    session?: { user?: { id?: string } } | null;
    /** What the endpoint produced. On a redirect this is the thrown
     *  `APIError`-shaped object, whose `headers` carry the `Location`. */
    returned?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Scope enumeration
// ---------------------------------------------------------------------------

/**
 * Reserved metadata sub-resources for the `metadata.<sub>:<verb>` scope
 * grammar. Currently only `types` is enforced (gates `POST /types`); the
 * list grows as new metadata-layer mutations land. Mirrors what
 * `parseScope` in `@withmarfa/shared` recognizes.
 */
const METADATA_SUBRESOURCES = ["types", "edge_types"] as const;

/**
 * Build the complete list of scope literals the plugin will accept.
 * Includes OIDC literals + every concrete `<type>:<verb>` from the type
 * registry + every `edge.<edgeType>:<verb>` from the edge registry + the
 * metadata sub-resource grammar + the global type wildcards (`*:read` /
 * `*:write`, the "Customize" full-access path) + the runtime / connected-
 * service namespace wildcards (`user.*`, `app.*`, `google.*`, …) + every
 * scope referenced by a configured permission bundle.
 *
 * This is the set of scopes that CAN be requested, which is wider than the
 * default consent bundle (the curated, per-type content set). Custom types
 * registered at runtime via `POST /types` are NOT picked up as concrete
 * scopes — a server restart re-enumerates from the (now-larger) registry.
 * The namespace wildcards are how an app reaches its own `user.*` types
 * without that restart: the wildcard is granted, and matches whatever
 * `user.*` types exist at check time.
 */
export function buildAllowedScopes(
  permissionBundles: PermissionBundle[] = getPermissionBundles(),
): string[] {
  const out = new Set<string>([
    // OIDC literals
    "openid",
    "profile",
    "email",
    "offline_access",
    // Metadata top-level
    "metadata:read",
    "metadata:write",
    // Global type wildcards — full access, offered only via "Customize".
    "*:read",
    "*:write",
    // Core subtree wildcards — requestable for back-compat (an app that asks
    // for all content at once). The default bundle uses concrete per-type
    // scopes instead; a requested wildcard renders as a single toggle.
    "core.*:read",
    "core.*:write",
    // Runtime + connected-service namespace wildcards. These cover an app's
    // own `user.*` / `app.*` runtime types and the integration namespaces the
    // static registry never enumerates. They stay REQUESTABLE (an app can ask
    // for them explicitly) but are deliberately NOT in the default consent
    // bundle — the default grant is the curated, per-type-narrowable content
    // set, so these only appear when an app opts into them.
    "user.*:read",
    "user.*:write",
    "app.*:read",
    "app.*:write",
    "google.*:read",
    "google.*:write",
    "raindrop.*:read",
    "raindrop.*:write",
    "readwise.*:read",
    "readwise.*:write",
    "todoist.*:read",
    "todoist.*:write",
    "withmarfa.*:read",
    "withmarfa.*:write",
  ]);

  // Item type scopes: `<typeId>:read|write` for every registered type.
  for (const typeId of TYPE_REGISTRY.keys()) {
    out.add(`${typeId}:read`);
    out.add(`${typeId}:write`);
  }

  // Edge type scopes: `edge.<edgeType>:read|write` for every edge type,
  // plus the `edge.*:read|write` wildcards.
  for (const edgeType of EDGE_TYPE_REGISTRY.keys()) {
    out.add(`edge.${edgeType}:read`);
    out.add(`edge.${edgeType}:write`);
  }
  out.add("edge.*:read");
  out.add("edge.*:write");

  // Metadata sub-resource scopes.
  for (const sub of METADATA_SUBRESOURCES) {
    out.add(`metadata.${sub}:read`);
    out.add(`metadata.${sub}:write`);
  }

  // Every scope referenced by a configured bundle (namespace wildcards).
  for (const scope of expandBundlesToScopes(permissionBundles)) {
    out.add(scope);
  }

  return Array.from(out).sort();
}

// ---------------------------------------------------------------------------
// Space resolution (auth_user.id → space_id via users table)
// ---------------------------------------------------------------------------

/**
 * Resolve a Better Auth user's space_id by joining through the `users`
 * table. Returns `undefined` in keys-mode (no users
 * table) or when the user has no space assigned yet.
 *
 * Used by:
 *   - `clientReference` at client-registration time
 *   - `customAccessTokenClaims` at token-issuance time
 *   - the consent after-hook when projecting `system.connection`
 */
export async function resolveSpaceIdForAuthUser(
  storage: Storage,
  authUserId: string,
): Promise<string | undefined> {
  if (!storage.users) return undefined;
  const user = await storage.users.getByAuthUserId(authUserId);
  return user?.space_id ?? undefined;
}

// ---------------------------------------------------------------------------
// Plugin construction
// ---------------------------------------------------------------------------

export interface OauthProviderOptions {
  /** Per-process API key salt — shared with the bearer middleware so
   *  `hashApiKey(token, salt)` returns identical output, letting the
   *  middleware look up `auth_oauth_access_token.token` directly. */
  apiKeySalt: string;
  /** The Storage handle. Threaded into clientReference + custom-claim
   *  callbacks and the grant-projection after-hooks. */
  storage: Storage;
  /** Base URL for the issuer (used in id_token claims). */
  baseURL: string;
}

/**
 * Same hash function the bearer middleware uses — keeps token validation
 * symmetric so a token-in-hand can be resolved to its `auth_oauth_access_token`
 * row by computing the same hash and looking up by primary key.
 */
function makeTokenHasher(salt: string) {
  return (token: string): string =>
    createHmac("sha256", salt).update(token).digest("hex");
}

/**
 * Construct the @better-auth/oauth-provider plugin with Marfa-specific
 * configuration. Used as one entry in the better-auth `plugins: [...]`
 * array in `instance.ts`.
 */
export function buildOauthProviderPlugin(opts: OauthProviderOptions) {
  const tokenHasher = makeTokenHasher(opts.apiKeySalt);
  const allowedScopes = buildAllowedScopes();

  return oauthProvider({
    // ----- Page wiring (Marfa-owned routes for both) -----
    loginPage: "/auth/sign-in",
    consentPage: "/auth/authorize",

    // ----- Dynamic client registration (RFC 7591) -----
    // `POST /auth/clients` is a public, no-auth endpoint for the
    // public-client model (PKCE replaces the client secret as the
    // binding). The plugin's deprecation note on unauthenticated DCR
    // is a future-watch item; revisit if MCP standardizes it.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    // ----- Space binding -----
    // `clientReference` is invoked at CLIENT-REGISTRATION time. The
    // returned value is written to `auth_oauth_client.reference_id`
    // and is immutable for the life of the client. Used for things
    // like "list all clients a space has registered."
    clientReference: async ({ user }) => {
      if (!user) return undefined;
      return resolveSpaceIdForAuthUser(opts.storage, user.id);
    },

    // `postLogin.consentReferenceId` is invoked at TOKEN-ISSUANCE
    // time (verified in @better-auth/oauth-provider@1.6.13). The return
    // value is written to
    // `auth_oauth_access_token.reference_id` for every minted token.
    //
    // The bearer middleware reads that column as the per-token
    // `space_id`:
    //
    //   middleware/auth.ts:325:
    //     const oauthSpaceId = oauthToken.referenceId ?? undefined;
    //
    // Without this callback, `reference_id` is NULL on every issued
    // token → the bearer middleware sees `space_id=undefined` →
    // keys-mode behavior → multi-space scoping breaks. With it, each
    // token is bound to the consenting user's space at issuance, so
    // the same client can serve users from different spaces without
    // cross-space leakage.
    //
    // The plugin's `postLogin` config wraps an OPTIONAL account-
    // selection flow (multi-account UX); Marfa has single-account-per-
    // session, so `shouldRedirect` always returns false and the
    // `/auth/post-login` page is never hit. We only wire this block
    // for the `consentReferenceId` field.
    //
    // Single-space self-hosts return `undefined` here (no `users`
    // store, so no space to resolve); their tokens land with
    // `reference_id=NULL` which is correct for keys-mode.
    postLogin: {
      page: "/auth/post-login",
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) =>
        resolveSpaceIdForAuthUser(opts.storage, user.id),
    },

    // ----- Scope grammar -----
    // Default scopes (clients can request these). `clientRegistrationAllowedScopes`
    // widens to the same set (registration accepts everything). Custom types
    // registered at runtime require a server restart to surface here.
    scopes: allowedScopes,
    clientRegistrationAllowedScopes: allowedScopes,
    // Ceilings for the paths with no consent screen in front of them —
    // values owned by `auth/mint-ceiling.ts` so the plugin options and
    // the Marfa-owned DCR mirror cannot drift. Without these, both
    // defaults fall through to `scopes` (the ENTIRE allowlist, `*:write`
    // included): a scope-less client_credentials request and a
    // scope-less registration each inherited everything.
    clientCredentialGrantDefaultScopes: CLIENT_CREDENTIALS_DEFAULT_SCOPES,
    clientRegistrationDefaultScopes: dcrDefaultScopes(),

    // ----- Silence the OAuth discovery-doc location warning -----
    // The plugin emits a WARN at construct time advising operators to
    // serve the issuer-suffixed discovery URL
    // (`/.well-known/oauth-authorization-server/auth` for our `/auth`
    // basePath). Marfa deliberately serves the bare-root variant
    // (`/.well-known/oauth-authorization-server` — see `app.ts`) and
    // documents the partial RFC 8414 §3 deviation in
    // `packages/server/CLAUDE.md` under "Discovery doc issuer field". The
    // `issuer` value matches what id_token signatures use, so RP-side token
    // validation works; only strict-RFC-validators that string-compare the
    // discovery URL host bite. Silence the WARN since the deviation is
    // intentional. Same rationale for the `openid-configuration` sibling.
    silenceWarnings: {
      oauthAuthServerConfig: true,
      openidConfig: true,
    },

    // ----- Token storage -----
    // Custom hash matching `hashApiKey(token, salt)` in middleware/auth.ts
    // so bearer-middleware lookup paths are symmetric: compute the same
    // hash, query `auth_oauth_access_token.token` directly.
    storeTokens: {
      hash: (token) => tokenHasher(token),
    },

    // ----- Token prefix -----
    // Preserves the `marfa_at_*` contract the bearer middleware uses to
    // distinguish OAuth tokens from API keys (`marfa_k1_*`). The middleware
    // ignores anything not matching one of these prefixes.
    prefix: {
      opaqueAccessToken: "marfa_at_",
      refreshToken: "marfa_rt_",
    },

    // ----- Custom claims -----
    // Access tokens are opaque (see plan §Caveats §3 for rationale —
    // DB lookup is sub-ms at our scale, revocation stays clean, no
    // scope-expansion to JWTs). The claims here surface on /oauth2/introspect
    // responses, which the bearer middleware does NOT call (it reads
    // `auth_oauth_access_token` directly + joins `system.connection`).
    // Kept anyway so external resource servers introspecting Marfa-issued
    // tokens get a usable claim set.
    customAccessTokenClaims: ({ user, scopes, referenceId }) => {
      const claims: Record<string, unknown> = {
        scope: scopes.join(" "),
      };
      if (referenceId) claims.space_id = referenceId;
      if (user) claims.user_id = user.id;
      return claims;
    },

    // id_token claims (OIDC). Reproduces the profile + email gate from
    // the (now-deleted) homegrown /auth/userinfo handler.
    customIdTokenClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {};
      if (scopes.includes("profile")) {
        claims.name = user.name;
        if ("image" in user && user.image) claims.picture = user.image;
      }
      if (scopes.includes("email")) {
        claims.email = user.email;
        if ("emailVerified" in user) {
          claims.email_verified = user.emailVerified;
        }
      }
      return claims;
    },

    // /userinfo response shape (OIDC) — same gating as id_token.
    customUserInfoClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {};
      if (scopes.includes("profile")) {
        claims.name = user.name;
        if ("image" in user && user.image) claims.picture = user.image;
      }
      if (scopes.includes("email")) {
        claims.email = user.email;
        if ("emailVerified" in user) {
          claims.email_verified = user.emailVerified;
        }
      }
      return claims;
    },
  });
}

// ---------------------------------------------------------------------------
// Projection plugin shell (refresh-replay before-hook only)
// ---------------------------------------------------------------------------

/**
 * Tiny BetterAuthPlugin shell hosting a single `hooks.before` matcher
 * for refresh-replay access-token cleanup.
 *
 * **Why a plugin shell rather than top-level `hooks`?** Top-level `hooks`
 * on the betterAuth instance only accepts a single before/after callable;
 * PLUGIN-level hooks accept the array+matcher shape needed for per-path
 * routing. The shell carries no endpoints/schema/init of its own — it
 * exists purely to host the before-hook. Same pattern works for adding
 * future plugin-level hooks (additional path matchers) without touching
 * the instance.ts wiring.
 *
 * **Why no after-hooks for projection / cascade / last_used_at?** Every
 * one of those flows is already owned by an explicit Marfa-side handler
 * that does the work deterministically:
 *   - consent projection + audit: `POST /auth/authorize/decision`
 *     (`routes/auth-consent.ts`) verifies the signed query, proxies to
 *     `/auth/oauth2/consent`, and projects only after the plugin returns a
 *     code-bearing registered callback. The explicit handler retains the
 *     verified client context needed to gate those side effects.
 *   - revoke cascade + audit: `DELETE /auth/grants/:id` and
 *     `POST /auth/grants/:id/revoke` (`routes/auth-pages.ts`) call
 *     `storage.oauthProvider.revokeTokensForGrant` and emit
 *     `auth.grant.revoked`. The plugin's `/oauth2/revoke` takes a
 *     token-in-hand, not a (client, user) pair, so resolving the right
 *     grant in a hook would require a before-hook table read pre-deletion
 *     — wasted effort when the user-facing revoke path already has the
 *     resolved client + user in scope.
 *   - `last_used_at` stamping: the bearer middleware stamps on every
 *     authenticated request via `stampOAuthGrantLastUsedByGrantKey`. A
 *     token-issuance after-hook would be redundant in the typical case
 *     (client uses the token immediately) and add a needless DB roundtrip.
 *
 * `apiKeySalt` is threaded in so the refresh-replay before-hook can
 * compute the same hash format the plugin uses (`hashApiKey(token, salt)`
 * via the custom `storeTokens.hash`). Without it, the before-hook is
 * conditionally omitted — the plugin still constructs (the shell is a
 * no-op surface).
 */
export function buildOauthProjectionPlugin(opts: {
  storage: Storage;
  apiKeySalt?: string;
  /** Issuer base URL; when set, the token endpoint validates and strips the
   *  RFC 8707 `resource` parameter so mints stay opaque. */
  baseURL?: string;
}) {
  const { storage, apiKeySalt, baseURL } = opts;
  const refreshHasher = apiKeySalt ? makeTokenHasher(apiKeySalt) : undefined;
  // The same enumeration `buildOauthProviderPlugin` hands the plugin as
  // `scopes`. Both are built at instance construction from the same
  // registries and the same configured bundles, so the narrowing hook and
  // the validation it runs ahead of always agree on what exists.
  const liveScopes = new Set(buildAllowedScopes());
  const acceptedResources = baseURL
    ? new Set(
        [
          stripTrailingSlash(baseURL),
          `${stripTrailingSlash(baseURL)}/mcp`,
        ].filter((v) => v.length > 0),
      )
    : undefined;
  return {
    id: "marfa-oauth-projection" as const,
    hooks: {
      after: [
        {
          // Gives the authorize endpoint's failures a signal. See
          // `logAuthorizeOutcome` for why nothing else produces one.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware((ctx: HookCtxLite) => {
            logAuthorizeOutcome(ctx);
            return Promise.resolve();
          }),
        },
      ],
      before: [
        {
          // Narrows the requested scope set on the authorize endpoint so a
          // scope the server cannot grant costs the requester that scope
          // rather than the whole authorization.
          //
          // The plugin validates with `new Set(client.scopes ?? opts.scopes)`
          // and redirects with `invalid_scope` the moment any requested
          // literal misses. Two things make that fire on requests that ought
          // to succeed. `auth_oauth_client.scopes` is written once at
          // registration and never refreshed, so it is a snapshot of an
          // allowlist that moves whenever the type registry does — stale in
          // both directions, holding scopes for deleted types and missing
          // scopes for new ones. And a client caching its discovered scope
          // set can ask for a literal that has since been retired.
          //
          // Narrowing is what RFC 6749 §3.3 provides for, and the granted set
          // travels back to the client on the token response, so an app that
          // asked for more than it got can tell. Dead-ending cannot be
          // recovered from at all: the client is 302'd to its own redirect
          // URI with an error and no way forward.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware((ctx: HookCtxLite) =>
            narrowAuthorizeScopes(ctx, storage, liveScopes),
          ),
        },
        ...(acceptedResources
          ? [
              {
                // RFC 8707 `resource` on the token endpoint, made safe for
                // opaque tokens. MCP clients MUST send the canonical URI of
                // the endpoint they will use the token against; the plugin
                // validates it against its audience list and then, whenever
                // a resource survives, mints a JWT-format access token
                // instead of the opaque one the bearer middleware resolves —
                // a token that verifies nowhere. Every audience this
                // deployment accepts is this same server, so restricting the
                // token's audience adds nothing the issuer boundary does not
                // already provide: no other resource server trusts this
                // authorization server. Validate against the accepted set,
                // refuse unknown resources up front with the RFC 8707 error,
                // and strip the parameter so the mint stays opaque.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) => {
                  normalizeResourceParameter(ctx, acceptedResources);
                  return Promise.resolve();
                }),
              },
            ]
          : []),
        ...(refreshHasher
          ? [
              {
                // Guards POST /auth/oauth2/token for the refresh_token grant:
                //  (1) an UNKNOWN/orphaned refresh token gets a clean RFC 6749
                //      `invalid_grant` (400) BEFORE the plugin can 500 on it —
                //      a 500 is non-terminal to clients, so a stale token (e.g.
                //      orphaned by a data reset) turns into a hard retry storm.
                //  (2) a REVOKED (replayed) token: pre-emptively zap the chain's
                //      access tokens (the plugin then returns invalid_grant),
                //      closing the gap where they'd outlive the refresh chain.
                //  Active tokens fall through to the plugin's rotation. The
                //  invalid_grant throw MUST propagate (not be swallowed).
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  guardRefreshTokenGrant(ctx, storage, refreshHasher),
                ),
              },
              {
                // Guards the same endpoint for the authorization_code grant:
                // a code whose grant the user has revoked must not redeem.
                // Revocation deletes outstanding codes, so in the ordinary
                // case this never fires; it holds for a code minted in the
                // window between the two writes, and for any future
                // revocation path that forgets to sweep them.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  guardAuthorizationCodeGrant(ctx, storage, refreshHasher),
                ),
              },
            ]
          : []),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh-token grant guard (before-hook)
// ---------------------------------------------------------------------------

/**
 * Before-hook for `/oauth2/token` with `grant_type=refresh_token`. One
 * lookup of the refresh-token row drives two behaviours:
 *
 *  1. **Unknown token → clean `invalid_grant` (400).** The
 *     @better-auth/oauth-provider plugin 500s when handed a refresh token
 *     with no matching row (e.g. orphaned by a data reset). A 500 is
 *     non-terminal to most OAuth clients, so they retry hard and the storm
 *     saturates the auth rate limit. We throw the RFC 6749 `invalid_grant`
 *     instead — terminal, so a well-behaved client stops. The throw
 *     propagates (it is NOT swallowed) to short-circuit the request.
 *
 *  2. **Revoked (replayed) token → zap the chain's access tokens.** The
 *     plugin marks the old refresh token `revoked` on rotation and returns
 *     `invalid_grant` on replay, but leaves the chain's access tokens valid
 *     until TTL. We pre-emptively delete them for (clientId, userId) so a
 *     parallel request can't slip through with one. Best-effort.
 *
 * Active tokens fall through to the plugin's rotation. Any failure of the
 * lookup itself fails open (logs, returns) so a transient DB blip never
 * turns a legitimate refresh into a hard error.
 */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function normalizeResourceParameter(
  ctx: HookCtxLite,
  accepted: Set<string>,
): void {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  const resource = body.resource;
  if (resource === undefined) return;
  const values =
    typeof resource === "string"
      ? [resource]
      : Array.isArray(resource)
        ? resource
        : null;
  if (
    !values ||
    values.some(
      (v) => typeof v !== "string" || !accepted.has(stripTrailingSlash(v)),
    )
  ) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_target",
      error_description:
        "The requested resource is not served by this authorization server.",
    });
  }
  delete body.resource;
}

/**
 * Before-hook for `GET|POST /oauth2/authorize`. Rewrites `ctx.query.scope`
 * to the intersection of what was requested, what this server can grant, and
 * what the client is registered for, so an unsatisfiable literal is dropped
 * instead of failing the authorization.
 *
 * **It refuses to narrow in three cases, each deliberately leaving the
 * plugin's own `invalid_scope` to fire:**
 *
 *  1. **No `scope` parameter.** The plugin then defaults the grant to
 *     `client.scopes ?? opts.scopes`; there is nothing to intersect, and
 *     writing a value in would invent a request the client never made.
 *  2. **The client cannot be resolved.** An unknown or unreadable client is
 *     the plugin's refusal to make, and narrowing against a ceiling we
 *     failed to read would be guessing at authority.
 *  3. **The intersection is empty.** An emptied `scope` reaches a consent
 *     screen with nothing on it, which the decision handler treats as a
 *     denial — a confusing dead-end swapped for a clear one. A request in
 *     which nothing at all is grantable is a genuine `invalid_scope`.
 *
 * A read failure fails open (log, return) so a transient database blip
 * degrades to the pre-existing behaviour rather than breaking sign-in.
 */
async function narrowAuthorizeScopes(
  ctx: HookCtxLite,
  storage: Storage,
  liveScopes: Set<string>,
): Promise<void> {
  const query = ctx.query;
  if (!query || typeof query !== "object") return;

  const rawScope = query.scope;
  if (typeof rawScope !== "string") return;
  const requested = rawScope.split(" ").filter((s) => s.length > 0);
  if (requested.length === 0) return;

  const clientId = query.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return;

  const oauth = storage.oauthProvider;
  if (!oauth) return;

  let ceiling: Set<string> | null;
  try {
    const client = await oauth.getClient(clientId);
    if (!client) return;
    // Mirrors the plugin's own `client.scopes ?? opts.scopes`: a null ceiling
    // tracks the live set, and an empty array is a real, empty ceiling that
    // narrows everything away — which case 3 below then declines to act on.
    ceiling = client.scopes === null ? null : new Set(client.scopes);
  } catch (err) {
    log("warn", "oauth authorize scope-narrowing precheck failed", {
      client_id: clientId,
      error: err,
    });
    return;
  }

  const granted: string[] = [];
  const unknownToServer: string[] = [];
  const outsideClientCeiling: string[] = [];
  for (const scope of requested) {
    if (!liveScopes.has(scope)) {
      unknownToServer.push(scope);
      continue;
    }
    if (ceiling && !ceiling.has(scope)) {
      outsideClientCeiling.push(scope);
      continue;
    }
    granted.push(scope);
  }

  if (unknownToServer.length === 0 && outsideClientCeiling.length === 0) return;
  if (granted.length === 0) return;

  query.scope = granted.join(" ");

  // Two log lines because they are two different events. A scope this server
  // has never heard of points at a client built against a different registry
  // or a type that has been deleted; a scope the server knows but the client
  // is not registered for points at the client's stored ceiling having fallen
  // behind the platform. Collapsing them loses the distinction that says
  // which one to go and fix.
  if (unknownToServer.length > 0) {
    log("info", "oauth authorize: dropped scopes this server cannot grant", {
      client_id: clientId,
      dropped_scopes: unknownToServer,
      granted_scopes: granted,
    });
  }
  if (outsideClientCeiling.length > 0) {
    log("info", "oauth authorize: dropped scopes outside the client ceiling", {
      client_id: clientId,
      dropped_scopes: outsideClientCeiling,
      granted_scopes: granted,
    });
  }
}

/**
 * OAuth error codes the authorize endpoint returns as ordinary flow control
 * rather than as a fault. A person declining consent, or a `prompt=none`
 * probe discovering it needs interaction, is the protocol working.
 *
 * Everything NOT in this set means a request that should have worked did
 * not: a client asking for a scope the server will not grant, an unknown or
 * disabled client, an unregistered redirect URI. Those are the operator's to
 * see.
 */
const EXPECTED_AUTHORIZE_ERRORS = new Set([
  "access_denied",
  "login_required",
  "consent_required",
  "interaction_required",
  "account_selection_required",
]);

/**
 * After-hook for `/oauth2/authorize`. Emits a log line whenever the endpoint
 * redirects with an OAuth error.
 *
 * **Without this, an authorize failure is indistinguishable from a success.**
 * The plugin signals failure with `throw ctx.redirect(...)`, which
 * `better-call` converts to a `Response` before Hono sees it — so
 * `app.onError` never runs, the 100%-on-error trace sampling never triggers,
 * and a fleet alert keyed on `level='error'` cannot fire. The request logger
 * records the path but not the query string, and the endpoint answers 302 on
 * every outcome, so neither the status nor the body separates them. A total
 * sign-in outage ran for days logging nothing but `GET /auth/oauth2/authorize
 * 302` at `info`, and was found by a person opening the app.
 *
 * The level is chosen from the error code rather than fixed, because these
 * are two different events sharing a shape. A declined consent is the
 * protocol working and would be noise at `warn`; an `invalid_scope` is a
 * client that cannot get in and is the whole reason this exists.
 *
 * Best-effort throughout: this is a reporting path, and it must never be the
 * reason an authorization fails.
 */
function logAuthorizeOutcome(ctx: HookCtxLite): void {
  try {
    const returned = ctx.context?.returned;
    if (!returned || typeof returned !== "object") return;
    const headers = (returned as { headers?: unknown }).headers;
    if (!(headers instanceof Headers)) return;
    const location = headers.get("location");
    if (!location) return;

    // `location` is relative-safe: a base is supplied only so URL parses, and
    // nothing downstream reads the origin.
    const params = new URL(location, "http://localhost").searchParams;
    const error = params.get("error");
    if (!error) return;

    const expected = EXPECTED_AUTHORIZE_ERRORS.has(error);
    log(expected ? "info" : "warn", "oauth authorize refused the request", {
      error_code: error,
      // Developer-facing by RFC 6749 §4.1.2.1, and the part that names which
      // scopes or parameter was at fault. It is the whole diagnostic value.
      error_description: params.get("error_description") ?? undefined,
      client_id:
        typeof ctx.query?.client_id === "string"
          ? ctx.query.client_id
          : undefined,
    });
  } catch {
    // A reporting path must never fail a request.
  }
}

async function guardRefreshTokenGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (body.grant_type !== "refresh_token") return;
  const refreshTokenRaw = body.refresh_token;
  if (typeof refreshTokenRaw !== "string" || refreshTokenRaw.length === 0)
    return;
  if (typeof storage.oauthProvider?.findRefreshTokenGrantKey !== "function")
    return;

  // The plugin strips the `prefix.refreshToken` (`marfa_rt_`) in its
  // `decodeRefreshToken` step, BEFORE calling our hasher. Strip here too so
  // the hash matches the stored value.
  const REFRESH_PREFIX = "marfa_rt_";
  const bare = refreshTokenRaw.startsWith(REFRESH_PREFIX)
    ? refreshTokenRaw.slice(REFRESH_PREFIX.length)
    : refreshTokenRaw;

  let row: Awaited<
    ReturnType<
      NonNullable<Storage["oauthProvider"]>["findRefreshTokenGrantKey"]
    >
  >;
  try {
    row = await storage.oauthProvider.findRefreshTokenGrantKey(hasher(bare));
  } catch (err) {
    // Fail open to the plugin — never 500 a legitimate refresh on a blip.
    log("warn", "oauth refresh-token precheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!row) {
    // Unknown token — terminal, spec-correct rejection (prevents the
    // plugin 500ing and the resulting client retry storm).
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "The refresh token is invalid, expired, or revoked.",
    });
  }
  if (!row.revoked) return; // active — let the plugin rotate

  // Confirmed replay. Zap access tokens for this grant chain so they can't
  // outlive the now-poisoned refresh chain. Best-effort + idempotent.
  try {
    if (
      typeof storage.oauthProvider.revokeAccessTokensForGrant === "function"
    ) {
      await storage.oauthProvider.revokeAccessTokensForGrant(
        row.clientId,
        row.userId,
      );
      log("info", "oauth refresh-replay: revoked access tokens for grant", {
        client_id: row.clientId,
        user_id: row.userId,
      });
    }
  } catch (err) {
    log("warn", "oauth refresh-replay zap failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Authorization-code grant guard (before-hook)
// ---------------------------------------------------------------------------

/**
 * Before-hook for `/oauth2/token` with `grant_type=authorization_code`.
 * Refuses a code whose grant the user has revoked.
 *
 * Revocation now deletes outstanding codes, so in the ordinary case this
 * never fires. It exists because the deletion alone is a sweep, and a sweep
 * has a window: a code minted between the consent-row delete and the code
 * delete would survive one and miss the other. It also holds if some later
 * revocation path is added and forgets the codes, which is exactly how this
 * defect arose in the first place — every existing path swept the token
 * tables and none of them knew codes lived somewhere else.
 *
 * Why this is worth two mechanisms rather than one. The obvious reading is
 * that a code expires in ten minutes so the exposure is ten minutes. That
 * bounds only when the code can be redeemed. What redemption yields is not
 * bounded: with `offline_access` the exchange returns a refresh token that
 * rotates indefinitely. A short race converts into a permanent grant, and
 * the user's own security page reports the app as revoked the whole time.
 *
 * Fails open on a lookup error and on an unrecognised code: the plugin owns
 * the real validation, and a transient database blip must not turn a
 * legitimate exchange into a hard failure.
 */
async function guardAuthorizationCodeGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (body.grant_type !== "authorization_code") return;
  const code = body.code;
  if (typeof code !== "string" || code.length === 0) return;
  if (
    typeof storage.oauthProvider?.findAuthorizationCodeGrantKey !== "function"
  )
    return;

  let row: Awaited<
    ReturnType<
      NonNullable<Storage["oauthProvider"]>["findAuthorizationCodeGrantKey"]
    >
  >;
  try {
    row = await storage.oauthProvider.findAuthorizationCodeGrantKey(
      hasher(code),
    );
  } catch (err) {
    log("warn", "oauth authorization-code precheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Unknown code: not ours to judge. The plugin returns the spec error.
  if (!row) return;
  if (row.hasConsent) return;

  log("info", "oauth authorization-code refused: grant revoked", {
    client_id: row.clientId,
  });
  throw new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description:
      "The authorization code is invalid, expired, or revoked.",
  });
}
