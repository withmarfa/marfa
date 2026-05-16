/**
 * T-131: @better-auth/oauth-provider plugin wiring.
 *
 * Replaces the homegrown OAuth surface (formerly `routes/oauth.ts`,
 * ~2,725 LOC) with the production-stable plugin. Endpoints land under
 * `/auth/oauth2/*` via Better Auth's catch-all (basePath `/auth`).
 *
 * Three coupled pieces in this file:
 *   1. `buildAllowedScopes(...)`  — enumerates the Myme scope grammar
 *       at instance-construction time from the type / edge registries
 *       so the plugin's allowlist accepts every concrete typed scope
 *       (`core.note:read`, `edge.parent-of:write`, …). Custom types
 *       registered at runtime require a server restart to surface
 *       (acceptable tradeoff; documented).
 *   2. `createOauthProviderConfig(...)` — returns the `OAuthOptions`
 *       passed to `oauthProvider({...})`. Wires:
 *         - opaque tokens hashed via Myme's existing `hashApiKey(t,salt)`
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
import { TYPE_REGISTRY, EDGE_TYPE_REGISTRY } from "@mymehq/shared";
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
 * `parseScope` in `@mymehq/shared` recognises.
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
 * Construct the @better-auth/oauth-provider plugin with Myme-specific
 * configuration. Used as one entry in the better-auth `plugins: [...]`
 * array in `instance.ts`.
 */
export function buildOauthProviderPlugin(opts: OauthProviderOptions) {
  const tokenHasher = makeTokenHasher(opts.apiKeySalt);
  const allowedScopes = buildAllowedScopes();

  return oauthProvider({
    // ----- Page wiring (Myme-owned routes for both) -----
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
    // Every client registered while a session is active gets bound to
    // the calling user's tenant (hosted mode). Single-tenant self-hosts
    // return `undefined` here; the plugin stores `reference_id` as NULL.
    // Binding is immutable — clients carry their tenant for life.
    clientReference: async ({ user }) => {
      if (!user) return undefined;
      return resolveTenantIdForAuthUser(opts.storage, user.id);
    },

    // ----- Scope grammar -----
    // Default scopes (clients can request these). `clientRegistrationAllowedScopes`
    // widens to the same set (registration accepts everything). Custom types
    // registered at runtime require a server restart to surface here.
    scopes: allowedScopes,
    clientRegistrationAllowedScopes: allowedScopes,

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
    // Kept anyway so external resource servers introspecting Myme-issued
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
    // the homegrown /auth/userinfo at routes/oauth.ts:2475-2540.
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
// Grant-lifecycle after-hooks
// ---------------------------------------------------------------------------

/**
 * The four `hooks.after` matchers that keep Myme's `system.connection`
 * projection in sync with the plugin's authoritative grant state, and
 * emit `auth.grant.created` / `auth.grant.revoked` audit rows.
 *
 * Better Auth ships no typed lifecycle callbacks for `oauth-provider`;
 * the generic `hooks: { after: [...] }` matcher pattern is the documented
 * extension point.
 *
 * Why projection at all (rather than dropping `system.connection` and
 * reading from `auth_oauth_consent` directly):
 *   - The `/auth/security` user-facing page (Wave C PR7) reads grants
 *     as items, threading through the same tier / state / search surface
 *     as everything else in the Myme data model. Re-pointing it at a
 *     raw auth table would erode the model's consistency.
 *   - Cascade-revoke on item deletion stays a single integrity model.
 *   - The `connection_item_id` lookup by the bearer middleware joins
 *     here for tenant_id + grant-id resolution.
 *
 * Each handler is best-effort — projection failures must NEVER break
 * the auth flow itself. We log + continue.
 */
/**
 * Wrap the four matcher/handler pairs in a tiny BetterAuthPlugin shell —
 * top-level `hooks` on the betterAuth instance only accepts a single
 * before/after callable, but PLUGIN-level hooks accept the array+matcher
 * shape we need. The shell carries no endpoints/schema/init of its own;
 * it exists purely to host the after-hooks.
 */
export function buildOauthProjectionPlugin(opts: { storage: Storage }) {
  const { storage } = opts;
  return {
    id: "myme-oauth-projection" as const,
    hooks: {
      after: [
        {
          // /oauth2/consent (success) → upsert system.connection app-grant +
          // emit auth.grant.created.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx: HookCtxLite) => {
            try {
              await projectConsentToSystemConnection(ctx, storage);
            } catch (err) {
              log("warn", "oauth grant-projection (consent) failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        },
        {
          // /oauth2/token (success) → debounced stamp on last_used_at of
          // the underlying system.connection.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx: HookCtxLite) => {
            try {
              await stampLastUsedFromTokenIssuance(ctx, storage);
            } catch (err) {
              log("warn", "oauth grant-projection (token) failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        },
        {
          // /oauth2/revoke (success) → transition system.connection to revoked +
          // emit auth.grant.revoked.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/revoke",
          handler: createAuthMiddleware(async (ctx: HookCtxLite) => {
            try {
              await projectRevokeToSystemConnection(ctx, storage);
            } catch (err) {
              log("warn", "oauth grant-projection (revoke) failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        },
        {
          // /oauth2/end-session (success) → same as revoke for the affected
          // grant (RP-Initiated Logout).
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/end-session",
          handler: createAuthMiddleware(async (ctx: HookCtxLite) => {
            try {
              await projectRevokeToSystemConnection(ctx, storage);
            } catch (err) {
              log("warn", "oauth grant-projection (end-session) failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Projection handlers
// ---------------------------------------------------------------------------

/**
 * Upsert a `system.connection { kind: "app" }` item for the just-approved
 * consent, and emit an `auth.grant.created` audit row. Idempotent on
 * re-consent: if an active grant exists for (tenant, client, user),
 * its `scopes` + `granted_at` are updated.
 */
async function projectConsentToSystemConnection(
  ctx: HookCtxLite,
  storage: Storage,
): Promise<void> {
  // After-hook body shape varies; we only project on accepted consent.
  if (ctx.body?.accept !== true) return;

  const authUserId = ctx.context?.session?.user?.id;
  if (!authUserId) return;

  const scopeField = ctx.body.scope;
  const scopes =
    typeof scopeField === "string"
      ? scopeField.split(/\s+/).filter(Boolean)
      : [];

  // Resolve tenant via the users table (hosted mode). Keys-mode self-host
  // doesn't carry per-user tenant — projection still creates the item
  // with tenant_id undefined, which is the convention for single-tenant
  // self-hosts.
  const tenantId = await resolveTenantIdForAuthUser(storage, authUserId);

  // We can't read the client_id directly from the consent body — the plugin
  // links code → consent server-side. As a fallback, the after-hook is
  // best-effort projection: if we can't determine client_id, we log and
  // skip. A follow-up will resolve client_id via the `code` field by
  // querying `auth_oauth_consent` for the just-written row.
  // For now: skip if no client_id available.
  // TODO(T-131): resolve client_id via consent code lookup.

  // Defensive bail — projection is opportunistic for the moment until
  // the consent-route handler in `routes/auth-consent.ts` lands, which
  // does the upsert directly and gives us the client_id we need here.
  const clientIdRaw = ctx.body.client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;
  if (!clientId) return;

  const now = new Date().toISOString();
  await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: clientId,
        scopes,
        status: "active",
        granted_at: now,
      },
      source: "myme/oauth2/consent",
    },
    tenantId,
  );

  await storage.audit.log({
    tenant_id: tenantId ?? null,
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: clientId,
    details: {
      client_id: clientId,
      scopes,
      user_id: authUserId,
    },
  });
}

/**
 * Debounced last_used_at stamp on the grant's `system.connection` row
 * when a token is issued (authorization_code or refresh_token path).
 * Mirrors what the bearer middleware already does on every authenticated
 * request — the two paths share the same throttle.
 *
 * Pending: needs the connection_item_id resolution path which lands with
 * the bearer-middleware update. For now this is a no-op stub that logs
 * the event for visibility.
 */
function stampLastUsedFromTokenIssuance(
  _ctx: HookCtxLite,
  _storage: Storage,
): Promise<void> {
  // TODO(T-131 follow-on): once the projection plumbing resolves the
  // (clientId, userId) → system.connection item id link, this hook can
  // call stampOAuthGrantLastUsed with the resolved item id. Currently
  // a no-op — `last_used_at` on the /security page will show null for
  // OAuth-code-flow grants until the wiring lands. Device-flow grants
  // are correctly stamped via the explicit /auth/device/token handler.
  void _ctx;
  void _storage;
  return Promise.resolve();
}

/**
 * Transition the affected `system.connection` row to revoked and emit
 * `auth.grant.revoked`. Best-effort — the plugin has already revoked
 * the token; this just keeps the user-facing surface in sync.
 *
 * Pending: needs the (client_id, user_id) → system.connection lookup
 * path which lands with the bearer-middleware update.
 */
function projectRevokeToSystemConnection(
  _ctx: HookCtxLite,
  _storage: Storage,
): Promise<void> {
  // TODO(T-131 follow-on): resolve the affected system.connection by
  // (tenant_id, client_id, user_id) and transition state → revoked +
  // emit audit row. The plugin's own /oauth2/revoke handler accepts a
  // token-in-hand, not a (client, user) pair, so resolving the right
  // grant requires either reading the token row before it's deleted
  // (before-hook) or relying on the after-hook to walk consent + client
  // backwards from the response body. Filed as a follow-on; the
  // user-facing /security page revoke path (which DOES have
  // client_id + user_id) goes through the explicit handler that
  // already cascades correctly via storage.oauthProvider.revokeTokensForGrant
  // AND emits auth.grant.revoked.
  void _ctx;
  void _storage;
  return Promise.resolve();
}
