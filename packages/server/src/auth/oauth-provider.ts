/**
 * T-131: @better-auth/oauth-provider plugin wiring.
 *
 * Replaces the homegrown OAuth surface (formerly `routes/oauth.ts`,
 * ~2,725 LOC) with the production-stable plugin. Endpoints land under
 * `/auth/oauth2/*` via Better Auth's catch-all (basePath `/auth`).
 *
 * Three coupled pieces in this file:
 *   1. `buildAllowedScopes(...)`  — enumerates the Marfa scope grammar
 *       at instance-construction time from the type / edge registries
 *       so the plugin's allowlist accepts every concrete typed scope
 *       (`core.note:read`, `edge.parent-of:write`, …). Custom types
 *       registered at runtime require a server restart to surface
 *       (acceptable tradeoff; documented).
 *   2. `createOauthProviderConfig(...)` — returns the `OAuthOptions`
 *       passed to `oauthProvider({...})`. Wires:
 *         - opaque tokens hashed via Marfa's existing `hashApiKey(t,salt)`
 *           so the bearer middleware shares the same hash format
 *         - `myme_at_` prefix on access tokens (bearer-middleware contract)
 *         - `myme_rt_` prefix on refresh tokens
 *         - `clientReference` → tenant_id resolved via the hosted-mode
 *           users table (auth_user.id → users.tenant_id)
 *         - `customAccessTokenClaims` / `customIdTokenClaims` /
 *           `customUserInfoClaims` for OIDC profile + email + tenant_id
 *         - `schema` override mapping the plugin's model names onto
 *           our `auth_oauth_*` Drizzle tables
 *   3. `buildOauthHooks(...)` — the four `hooks.after` matchers that
 *       project plugin grant lifecycle into `system.connection` items
 *       and emit `auth.grant.created` / `auth.grant.revoked` audit rows.
 *       These are the user-facing surface — the `/auth/security` page
 *       reads `system.connection app` rows directly. Audit-row shapes
 *       are NEW under T-131 (the homegrown surface had no clean wrapper
 *       seam; the plugin's hooks API gives us one for the first time).
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { createAuthMiddleware } from "better-auth/api";
import { createHmac } from "node:crypto";
import { TYPE_REGISTRY, EDGE_TYPE_REGISTRY } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
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
  context?: { session?: { user?: { id?: string } } | null };
}

// ---------------------------------------------------------------------------
// Scope enumeration
// ---------------------------------------------------------------------------

/**
 * Reserved metadata sub-resources for the `metadata.<sub>:<verb>` scope
 * grammar. Currently only `types` is enforced (gates `POST /types`); the
 * list grows as new metadata-layer mutations land. Mirrors what
 * `parseScope` in `@withmarfa/shared` recognises.
 */
const METADATA_SUBRESOURCES = ["types"] as const;

/**
 * Build the complete list of scope literals the plugin will accept.
 * Includes OIDC literals + every concrete `<type>:<verb>` from the type
 * registry + every `edge.<edgeType>:<verb>` from the edge registry +
 * the metadata sub-resource grammar.
 *
 * Custom types registered at runtime via `POST /types` are NOT picked up
 * automatically — a server restart re-enumerates from the (now-larger)
 * registry. This is an explicit tradeoff: the plugin's scope-allowlist
 * is static, and supporting per-tenant dynamic allowlists would require
 * forking the validation path. Restart cost is acceptable; document in
 * the operator runbook if it becomes friction.
 */
export function buildAllowedScopes(): string[] {
  const out = new Set<string>([
    // OIDC literals (T-074)
    "openid",
    "profile",
    "email",
    "offline_access",
    // Metadata top-level
    "metadata:read",
    "metadata:write",
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

  return Array.from(out).sort();
}

// ---------------------------------------------------------------------------
// Tenant resolution (auth_user.id → tenant_id via users table)
// ---------------------------------------------------------------------------

/**
 * Resolve a Better Auth user's tenant_id by joining through the `users`
 * table (the T-074 bridge). Returns `undefined` in keys-mode (no users
 * table) or when the user has no tenant assigned yet.
 *
 * Used by:
 *   - `clientReference` at client-registration time
 *   - `customAccessTokenClaims` at token-issuance time
 *   - the consent after-hook when projecting `system.connection`
 */
export async function resolveTenantIdForAuthUser(
  storage: Storage,
  authUserId: string,
): Promise<string | undefined> {
  if (!storage.users) return undefined;
  const user = await storage.users.getByAuthUserId(authUserId);
  return user?.tenant_id ?? undefined;
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
    // Mirrors today's behaviour: `POST /auth/clients` was a public,
    // no-auth endpoint for the public-client model (PKCE replaces the
    // client secret as the binding). The plugin's deprecation note
    // (tied to MCP standardising unauth DCR) is a future-watch item;
    // tracked in T-099.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    // ----- Tenant binding -----
    // `clientReference` is invoked at CLIENT-REGISTRATION time. The
    // returned value is written to `auth_oauth_client.reference_id`
    // and is immutable for the life of the client. Used for things
    // like "list all clients a tenant has registered."
    clientReference: async ({ user }) => {
      if (!user) return undefined;
      return resolveTenantIdForAuthUser(opts.storage, user.id);
    },

    // F5 — `postLogin.consentReferenceId` is invoked at TOKEN-ISSUANCE
    // time (verified in @better-auth/oauth-provider@1.6.9 `index.mjs:43,
    // :3829`). The return value is written to
    // `auth_oauth_access_token.reference_id` for every minted token.
    //
    // The bearer middleware reads that column as the per-token
    // `tenant_id`:
    //
    //   middleware/auth.ts:325:
    //     const oauthTenantId = oauthToken.referenceId ?? undefined;
    //
    // Without this callback, `reference_id` is NULL on every issued
    // token → the bearer middleware sees `tenant_id=undefined` →
    // keys-mode behavior → multi-tenant scoping breaks. With it, each
    // token is bound to the consenting user's tenant at issuance, so
    // the same client can serve users from different tenants without
    // cross-tenant leakage.
    //
    // The plugin's `postLogin` config wraps an OPTIONAL account-
    // selection flow (multi-account UX); Marfa has single-account-per-
    // session, so `shouldRedirect` always returns false and the
    // `/auth/post-login` page is never hit. We only wire this block
    // for the `consentReferenceId` field.
    //
    // Single-tenant self-hosts return `undefined` here (no `users`
    // store, so no tenant to resolve); their tokens land with
    // `reference_id=NULL` which is correct for keys-mode.
    postLogin: {
      page: "/auth/post-login",
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) =>
        resolveTenantIdForAuthUser(opts.storage, user.id),
    },

    // ----- Scope grammar -----
    // Default scopes (clients can request these). `clientRegistrationAllowedScopes`
    // widens to the same set (registration accepts everything). Custom types
    // registered at runtime require a server restart to surface here.
    scopes: allowedScopes,
    clientRegistrationAllowedScopes: allowedScopes,

    // ----- Silence the OAuth discovery-doc location warning -----
    // T-193: the plugin emits a WARN at construct time advising operators to
    // serve the issuer-suffixed discovery URL
    // (`/.well-known/oauth-authorization-server/auth` for our `/auth`
    // basePath). Marfa deliberately serves the bare-root variant
    // (`/.well-known/oauth-authorization-server` — see `app.ts:450`) and
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
    // Preserves the `myme_at_*` contract the bearer middleware uses to
    // distinguish OAuth tokens from API keys (`myme_k1_*`). The middleware
    // ignores anything not matching one of these prefixes.
    prefix: {
      opaqueAccessToken: "myme_at_",
      refreshToken: "myme_rt_",
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
      if (referenceId) claims.tenant_id = referenceId;
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
 *     (`routes/auth-consent.ts`) handles it before proxying to
 *     `/auth/oauth2/consent`. We need the explicit handler because the
 *     plugin's consent endpoint doesn't carry `client_id` in its body
 *     (it links via the pre-minted code), making the after-hook approach
 *     fragile.
 *   - revoke cascade + audit: `DELETE /auth/grants/:id` and
 *     `POST /auth/grants/:id/revoke` (`routes/oauth.ts`) call
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
}) {
  const { storage, apiKeySalt } = opts;
  const refreshHasher = apiKeySalt ? makeTokenHasher(apiKeySalt) : undefined;
  return {
    id: "marfa-oauth-projection" as const,
    hooks: {
      before: [
        ...(refreshHasher
          ? [
              {
                // T-131 follow-on (refresh-replay): the plugin detects stale
                // refresh tokens (rotation: old marked `revoked: true`,
                // new issued; replay finds old → plugin deletes refresh
                // chain + throws invalid_grant). The plugin does NOT
                // delete access tokens issued from the same chain, leaving
                // them valid until TTL (default 1h). We close that gap:
                // on every /oauth2/token request with grant_type=
                // refresh_token, we hash the request's refresh_token and
                // peek at the row — if it exists AND revoked, this is a
                // replay attempt and we pre-emptively delete access tokens
                // for (clientId, userId). The plugin's own logic then
                // runs (returning invalid_grant); access tokens are gone.
                //
                // Best-effort — if the hash lookup misses or the cleanup
                // fails, the request continues unmolested and the existing
                // 1h TTL still bounds exposure. Idempotent on repeat calls.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware(async (ctx: HookCtxLite) => {
                  try {
                    await detectAndZapReplayedAccessTokens(
                      ctx,
                      storage,
                      refreshHasher,
                    );
                  } catch (err) {
                    log("warn", "oauth refresh-replay check failed", {
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }),
              },
            ]
          : []),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh-replay before-hook handler
// ---------------------------------------------------------------------------

/**
 * T-131 follow-on (refresh-replay): runs before the plugin handles a
 * `/oauth2/token` request. If the request body is a `grant_type=
 * refresh_token` request AND the supplied refresh token corresponds to
 * a row marked `revoked: true`, this is a replay attempt — the plugin
 * is about to delete the refresh chain + throw invalid_grant. We
 * pre-emptively delete access tokens for the same (clientId, userId)
 * so a parallel request can't slip through with one of them.
 *
 * Best-effort throughout: if the hash lookup misses (refresh row
 * already cleaned up), we skip silently. If access-token deletion
 * fails, we log and continue. The 1h TTL on access tokens always
 * bounds exposure regardless.
 *
 * Why we don't also wire after-hooks for /oauth2/consent (projection),
 * /oauth2/revoke (cascade), /oauth2/token (last_used_at), /oauth2/end-
 * session (cascade): every one of those flows is owned by an explicit
 * Marfa-side handler that does the work deterministically (consent →
 * `POST /auth/authorize/decision`; revoke → `/auth/grants/:id/revoke`
 * and `DELETE /auth/grants/:id`; last_used_at → bearer middleware on
 * the next authenticated request). Adding after-hooks would double-write
 * or no-op. Kept the shell so the before-hook has a home, and so future
 * hook additions have a single place to land.
 */
async function detectAndZapReplayedAccessTokens(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  const grantType = body.grant_type;
  if (grantType !== "refresh_token") return;
  const refreshTokenRaw = body.refresh_token;
  if (typeof refreshTokenRaw !== "string" || refreshTokenRaw.length === 0)
    return;

  // The plugin strips the `prefix.refreshToken` (`myme_rt_`) BEFORE
  // calling our hasher (verified `index.mjs:394`) — same shape as the
  // access-token side. To match the stored hash, strip here too.
  const REFRESH_PREFIX = "myme_rt_";
  const bare = refreshTokenRaw.startsWith(REFRESH_PREFIX)
    ? refreshTokenRaw.slice(REFRESH_PREFIX.length)
    : refreshTokenRaw;
  const tokenHash = hasher(bare);
  if (typeof storage.oauthProvider?.findRefreshTokenGrantKey !== "function") {
    return;
  }
  const row = await storage.oauthProvider.findRefreshTokenGrantKey(tokenHash);
  if (!row) return;
  if (!row.revoked) return;

  // Confirmed replay. Zap access tokens for this grant chain so they
  // can't outlive the now-poisoned refresh chain. Idempotent — re-runs
  // on burst replays harmlessly hit zero rows.
  if (typeof storage.oauthProvider.revokeAccessTokensForGrant === "function") {
    await storage.oauthProvider.revokeAccessTokensForGrant(
      row.clientId,
      row.userId,
    );
  }
  log("info", "oauth refresh-replay: revoked access tokens for grant", {
    client_id: row.clientId,
    user_id: row.userId,
  });
}
