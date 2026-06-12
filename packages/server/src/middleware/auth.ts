import { createHmac } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import {
  MarfaError,
  ErrorCode,
  classifyNamespace,
  resolveTypePermission,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToOidcScopes,
  edgePermissionCovers,
  metadataPermissionCovers,
} from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Hono environment type (shared across all routes)
// ---------------------------------------------------------------------------

// `extends Record<string, unknown>` is required by @hono/zod-openapi's router
// generic — pure interfaces don't satisfy it without the index signature.
export interface AppEnv extends Record<string, unknown> {
  Variables: {
    apiKey: ApiKey | undefined;
    isBootstrap: boolean;
    authType: "api_key" | "oauth" | undefined;
    requestId: string;
    /**
     * The resolved `AppConfig`, stamped onto every request by `createApp`.
     * Lets middleware and route handlers read env-derived settings from
     * the single config source instead of re-reading `process.env`.
     */
    config: AppConfig;
    /**
     * Effective client IP for the current request, resolved once via
     * `getClientIp` and stashed by `clientIpMiddleware`. Routes thread
     * this into `audit.log({ client_ip: c.var.clientIp ?? null })` so
     * every audit row carries the originator's IP. `null` when the peer
     * cannot be determined (synthetic test contexts) or when the caller
     * is not behind a Hono request (system-initiated audits go through
     * the storage layer directly with `client_ip: null`).
     */
    clientIp: string | null;
    /**
     * Cycle metadata for events published from this request. Resolved
     * by `cycleMiddleware` after auth from either the inbound
     * `X-Marfa-Cycle-Origin` / `X-Marfa-Cycle-Hop` headers (a connector
     * reacting to a parent event — the SDK threads them via
     * `ConnectionClient.request()`) or from the caller's api key when
     * the headers are absent (the chain head).
     *
     * `publish()` and `publishEdge()` in `pubsub.ts` read the resolved
     * cycle from `cycleRequestContext` (AsyncLocalStorage) automatically;
     * routes do NOT thread this through. The `c.var.cycle` binding
     * remains available for diagnostic reads (preview surfaces, audit
     * enrichment) and stays in lockstep with the ALS — `cycleMiddleware`
     * writes both from the same resolved value.
     *
     * **Never `null`.** A human-issued chain head is `{
     * originatingConnectionId: null, hopCount: 0 }` (the explicit
     * sentinel); a connector chain head is `{ originatingConnectionId:
     * <connection_id>, hopCount: 0 }`; a connector continuing a chain
     * is `{ originatingConnectionId: <head>, hopCount: parent + 1 }`.
     * The `null` originator on the human sentinel is the contract
     * `passesHopBudget` keys on to bypass the budget — see
     * `pubsub.ts:passesHopBudget`.
     */
    cycle: {
      originatingConnectionId: string | null;
      hopCount: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Key hashing
// ---------------------------------------------------------------------------

const KEY_PREFIX = "marfa_k1_";
const ACCESS_TOKEN_PREFIX = "marfa_at_";
const DEBOUNCE_MS = 3600_000; // 1 hour

/**
 * Soft cap on the in-process `lastUsedCache`. Each entry is a
 * (string id, number timestamp) pair — a few dozen bytes; 32k entries
 * caps memory at well under 1MB and accommodates the largest realistic
 * hot-key set on a single instance. Eviction is FIFO (oldest insertion);
 * touched entries are re-inserted to refresh their position.
 */
const LAST_USED_CACHE_MAX = 32_768;

export function hashApiKey(raw: string, salt: string): string {
  return createHmac("sha256", salt).update(raw).digest("hex");
}

/**
 * Stamps a key as recently-touched in the cache, with FIFO eviction
 * past `LAST_USED_CACHE_MAX`. Map iteration order is insertion order in
 * JS, so deleting the first key drops the oldest entry. Re-insertion of
 * an existing key (delete + set) moves it to the back, keeping hot keys
 * in cache.
 */
export function touchLastUsedCache(
  cache: Map<string, number>,
  key: string,
  now: number,
): void {
  cache.delete(key);
  cache.set(key, now);
  if (cache.size > LAST_USED_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// OAuth grant `last_used_at` debounce — module-scoped
// ---------------------------------------------------------------------------

/**
 * Module-scoped debounce cache for OAuth-grant `last_used_at` writes,
 * promoted from a closure inside `authMiddleware` so route handlers
 * (token-issuance / refresh paths that don't carry a bearer header
 * through the middleware) can share the same throttle. Keys are
 * `oauth:<connection_item_id>`; values are millisecond timestamps.
 *
 * **First-line short-circuit, not the floor.** The DB layer uses a
 * conditional UPDATE in `OAuthStore.updateLastUsedAt`, writing only
 * when the existing `properties.last_used_at` is older than
 * `DEBOUNCE_MS`. That makes the debounce authoritative across
 * instances. This in-memory cache stays to skip a DB round-trip when
 * the calling instance has already stamped inside the window — same
 * role as the api-key middleware's closure-local cache.
 */
const oauthLastUsedCache = new Map<string, number>();

/**
 * Stamp `last_used_at` on the underlying `system.connection`
 * (kind: app) for an OAuth grant. Two-layer debounce:
 *
 *   1. Module-scoped in-memory cache (`oauthLastUsedCache`) — skips
 *      the DB round-trip when this instance has already stamped
 *      inside `DEBOUNCE_MS`.
 *   2. DB-side conditional UPDATE in `OAuthStore.updateLastUsedAt` —
 *      collapses concurrent writes from any number of instances to at
 *      most one row write per `DEBOUNCE_MS` per grant.
 *
 * Callers fire-and-forget — failures must never break the auth path.
 * Tenant-scoped via `tenantId` so a hosted-mode caller cannot trip
 * this against another tenant's grant row.
 *
 * Used by:
 *   - `authMiddleware` for every authenticated bearer-bearing request.
 *   - The `/auth/oauth2/token` (authorization_code + refresh_token) and
 *     `/auth/device/token` handlers, which issue tokens without
 *     resolving a bearer through the middleware.
 */
export async function stampOAuthGrantLastUsed(
  storage: Storage,
  connectionItemId: string,
  tenantId: string | undefined,
): Promise<void> {
  const cacheKey = `oauth:${connectionItemId}`;
  const now = Date.now();
  const lastTracked = oauthLastUsedCache.get(cacheKey) ?? 0;
  if (now - lastTracked <= DEBOUNCE_MS) return;
  touchLastUsedCache(oauthLastUsedCache, cacheKey, now);
  try {
    await storage.oauth.updateLastUsedAt(
      connectionItemId,
      tenantId ?? null,
      DEBOUNCE_MS,
    );
  } catch {
    // Best-effort; the cache mark above prevents a stampede.
  }
}

/**
 * Stamp `last_used_at` keyed by (tenantId, clientId, authUserId)
 * instead of a pre-resolved `connection_item_id`.
 *
 * The bearer middleware needs this because the plugin's
 * `auth_oauth_access_token` row doesn't carry a FK to the projected
 * `system.connection`. We resolve the item id on first call inside the
 * debounce window, then call the existing `stampOAuthGrantLastUsed`.
 * Both lookups + stamp share the same `oauthLastUsedCache`, so
 * per-request cost is one cheap Map lookup once the cache is warm.
 *
 * Cache key shape (`oauth-grantkey:<client>:<user>`) differs from
 * `stampOAuthGrantLastUsed`'s `oauth:<id>`, so the two keyspaces don't
 * collide but a write through either path correctly skips a second write
 * within the same window.
 *
 * Fire-and-forget; failures swallowed.
 */
export async function stampOAuthGrantLastUsedByGrantKey(
  storage: Storage,
  opts: {
    tenantId: string | undefined;
    clientId: string;
    authUserId: string;
  },
): Promise<void> {
  const cacheKey = `oauth-grantkey:${opts.clientId}:${opts.authUserId}`;
  const now = Date.now();
  const lastTracked = oauthLastUsedCache.get(cacheKey) ?? 0;
  if (now - lastTracked <= DEBOUNCE_MS) return;
  // Mark BEFORE the lookup — if the lookup misses (no projection yet),
  // we still want to skip retrying for the rest of the window.
  touchLastUsedCache(oauthLastUsedCache, cacheKey, now);
  try {
    const itemId = await storage.oauthProvider?.findGrantItemId({
      tenantId: opts.tenantId ?? null,
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
    if (!itemId) return;
    await storage.oauth.updateLastUsedAt(
      itemId,
      opts.tenantId ?? null,
      DEBOUNCE_MS,
    );
  } catch {
    // Best-effort; the cache mark above prevents a stampede.
  }
}

/** Test helper: drops every entry from the OAuth grant debounce cache.
 *  Tests calling `stampOAuthGrantLastUsed` directly or exercising the
 *  refresh / userinfo paths use this between cases to avoid carryover. */
export function _clearOAuthLastUsedCacheForTesting(): void {
  oauthLastUsedCache.clear();
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export function authMiddleware(storage: Storage, salt: string) {
  // Bounded LRU keyed by `key:<api-key-id>` for the stored-key path.
  // OAuth grants get their throttle from `oauthLastUsedCache` (module-
  // scoped) so route-handler stampers can share the same window.
  const lastUsedCache = new Map<string, number>();

  return createMiddleware<AppEnv>(async (c, next) => {
    // Bootstrap detection: POST /keys on an instance that has never
    // had a key. The gate is a persistent `settings.bootstrapped`
    // sentinel, NOT a live `keys.count() === 0` check — revoking every
    // key must not re-open bootstrap (would let an unauthenticated
    // caller mint an admin key and take over the instance).
    if (c.req.method === "POST" && c.req.path === "/keys") {
      const bootstrapped = await storage.settings.get("bootstrapped");
      if (bootstrapped !== "true") {
        c.set("apiKey", undefined);
        c.set("isBootstrap", true);
        c.set("authType", undefined);
        return next();
      }
    }

    c.set("isBootstrap", false);

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      c.set("apiKey", undefined);
      c.set("authType", undefined);
      return next();
    }

    const token = authHeader.slice(7);

    // OAuth access token (marfa_at_* prefix).
    //
    // Looks up the @better-auth/oauth-provider plugin's
    // `auth_oauth_access_token` directly. The plugin's `storeTokens.hash`
    // is wired to `hashApiKey(token, salt)` in `auth/oauth-provider.ts`,
    // so a token in hand resolves to its row by exact-match on the
    // hashed `token` column.
    //
    // **Side-channel join, NOT custom claims.** The plan's contingency
    // applies here (§Caveats §3 in the plan file): the plugin's
    // `customAccessTokenClaims` only embeds in JWT tokens, and Marfa
    // keeps opaque tokens (correct for our profile — DB lookup is
    // sub-ms, revocation stays clean). The row itself carries
    // `referenceId` (= tenant_id, populated by `clientReference` at
    // issuance), `userId`, `clientId`, and `scopes`. Everything the
    // synthetic ApiKey needs comes from the single row.
    //
    // **`connection_item_id` derivation.** The user-facing `system.connection`
    // projection (`{ kind: "app" }` items) is maintained by the
    // grant-projection after-hooks for the `/security` page surface,
    // not consulted here. We synthesise a stable label/source string
    // from `${clientId}:${userId}` so audit rows attribute correctly
    // without an extra DB roundtrip.
    if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      // The plugin's `storeTokens.hash` strips the `prefix.opaqueAccessToken`
      // before calling our hasher (verified in
      // @better-auth/oauth-provider@1.6.13 —
      // `tokenValue.replace(opts.prefix.opaqueAccessToken, "")` runs before
      // `getStoredToken` invokes our hash function). To stay symmetric with
      // the plugin's stored hash, we ALSO strip the prefix before hashing
      // for lookup. Device-flow's `mintTokenPair` callers (in `routes/auth-pages.ts`
      // + `test-utils.ts`) match the same convention.
      const bare = token.slice(ACCESS_TOKEN_PREFIX.length);
      const hash = hashApiKey(bare, salt);
      const oauthToken = await storage.oauthProvider?.validateAccessToken(hash);

      if (!oauthToken) {
        c.set("apiKey", undefined);
        c.set("authType", undefined);
        return next();
      }

      const typePermissions = scopesToTypePermissions(oauthToken.scopes);
      const edgePermissions = scopesToEdgePermissions(oauthToken.scopes);
      const metadataPermissions = scopesToMetadataPermissions(
        oauthToken.scopes,
      );
      // OIDC literals (openid / profile / email) project onto a separate
      // field consumed only by /oauth/userinfo. They never bleed into
      // type / edge / metadata permission maps.
      const oidcScopes = Array.from(scopesToOidcScopes(oauthToken.scopes));
      // Tenant id from the plugin's referenceId column (= our clientReference
      // output, which returns the user's tenant_id at consent time).
      const oauthTenantId = oauthToken.referenceId ?? undefined;
      // Stable composite label/source. Used in audit rows; doesn't need
      // to be a real foreign-key handle — system.connection projection
      // is maintained separately.
      const grantHandle = `${oauthToken.clientId}:${oauthToken.userId ?? "anon"}`;
      const createdAtIso = oauthToken.createdAtMs
        ? new Date(oauthToken.createdAtMs).toISOString()
        : new Date().toISOString();
      // Project the underlying user's role onto the synthetic principal
      // so admin-gated routes (`/keys`, `/admin/*`) work for
      // OAuth-authenticated admins. `is_platform` stays hardcoded false
      // — platform-admin is an operator-tier flag exclusive to API keys
      // with explicit `is_platform: true`; OAuth tokens never claim it.
      // Falls back to `member` when no `users` row maps to the
      // auth_user (an unmapped auth_user, or a token whose user was
      // hard-deleted mid-session).
      let projectedRole: "admin" | "tenant_admin" | "member" = "member";
      if (oauthToken.userId && storage.users) {
        const user = await storage.users.getByAuthUserId(oauthToken.userId);
        if (user) projectedRole = user.role;
      }
      c.set("apiKey", {
        id: oauthToken.id,
        tenant_id: oauthTenantId,
        label: `oauth:${grantHandle}`,
        source: `oauth:${grantHandle}`,
        role: projectedRole,
        default_tier: "library",
        is_platform: false,
        // OAuth tokens are limited to their granted scopes on the data
        // plane — the role bypass does not apply. The user's role is the
        // ceiling on what they could grant, not a full-access pass for the
        // app. See `roleBypassesPermissionMaps`.
        scope_enforced: true,
        type_permissions: typePermissions,
        extension_permissions: {},
        edge_permissions: edgePermissions,
        metadata_permissions: metadataPermissions,
        oidc_scopes: oidcScopes,
        created_at: createdAtIso,
        last_used_at: null,
      });
      c.set("authType", "oauth");

      if (oauthToken.userId) {
        void stampOAuthGrantLastUsedByGrantKey(storage, {
          tenantId: oauthTenantId,
          clientId: oauthToken.clientId,
          authUserId: oauthToken.userId,
        });
      }

      return next();
    }

    if (token.startsWith(KEY_PREFIX)) {
      const hash = hashApiKey(token, salt);
      const stored = await storage.keys.validate(hash);

      if (!stored) {
        c.set("apiKey", undefined);
        c.set("authType", undefined);
        return next();
      }

      c.set("apiKey", {
        id: stored.id,
        tenant_id: stored.tenant_id ?? undefined,
        label: stored.label,
        source: stored.source,
        role: stored.role,
        default_tier: stored.default_tier,
        is_platform: stored.is_platform,
        is_runtime_credential: stored.is_runtime_credential,
        connection_id: stored.connection_id,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      });
      c.set("authType", "api_key");

      // DB-side conditional UPDATE is the authoritative floor; this cache
      // skips the round-trip when this instance already wrote within DEBOUNCE_MS.
      const cacheKey = `key:${stored.id}`;
      const now = Date.now();
      const lastTracked = lastUsedCache.get(cacheKey) ?? 0;
      if (now - lastTracked > DEBOUNCE_MS) {
        touchLastUsedCache(lastUsedCache, cacheKey, now);
        await storage.keys.updateLastUsed(stored.id);
      }

      return next();
    }

    c.set("apiKey", undefined);
    c.set("authType", undefined);
    return next();
  });
}

// ---------------------------------------------------------------------------
// Access control helpers (context-agnostic)
// ---------------------------------------------------------------------------

export function checkAuth(apiKey: ApiKey | undefined): ApiKey {
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }
  return apiKey;
}

export function checkAdmin(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (key.role !== "admin") {
    throw new MarfaError(ErrorCode.FORBIDDEN, "Admin access required");
  }
  return key;
}

/**
 * Tenant-bounded admin gate. Admits both `admin` (platform admin, full
 * instance authority) and `tenant_admin` (tenant-bounded admin within
 * own `tenant_id`). Used for routes that genuinely belong inside a
 * tenant — own keys, webhooks, types, connections, extensions, blobs,
 * export. Routes that need platform authority (system config, cross-tenant
 * ops, platform-credential mint) keep `checkAdmin` / `requireAdmin`.
 *
 * Cross-tenant safety is the route's responsibility:
 *   - Routes that take a path id (`/webhooks/:id`, `/keys/:id`) must pass
 *     `key.tenant_id` into the storage lookup so a tenant_admin
 *     attempting to address another tenant's resource gets a 404.
 *   - Routes that list resources must pass `key.tenant_id` into the list
 *     query so tenant_admins see only their own.
 *   - Routes that create resources must stamp the new resource's
 *     `tenant_id` from `key.tenant_id` (the storage layer typically does
 *     this; verify on each callsite).
 *
 * The DB-layer Postgres RLS policies enforce tenant isolation
 * independently; the application layer is the additional fence and
 * every tenant_admin-accepting route must thread `tenant_id` correctly.
 */
export function checkTenantAdmin(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (key.role !== "admin" && key.role !== "tenant_admin") {
    throw new MarfaError(ErrorCode.FORBIDDEN, "Admin access required");
  }
  return key;
}

/**
 * Whether a credential skips the per-resource permission maps (type / edge /
 * metadata) by virtue of its role. `admin` and `tenant_admin` keys are
 * admin-shaped within their scope and bypass the maps — EXCEPT
 * `scope_enforced` credentials (OAuth-derived synthetic keys), which are
 * held to exactly the scopes the user granted the app. A user's role is the
 * ceiling on what an app can be granted, not an automatic full-access pass
 * for every app they sign into. Role gates (`requireTenantAdmin` /
 * `requireAdmin`) still consult the projected role regardless of this flag —
 * only the data-plane permission-map checks honour it.
 */
function roleBypassesPermissionMaps(key: ApiKey): boolean {
  if (key.scope_enforced) return false;
  return key.role === "admin" || key.role === "tenant_admin";
}

export function checkTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);

  // Platform-credential gate. Writes to `system.*` (and the internal-only
  // `marfa.*`) require `is_platform: true` independent of role — tenant
  // admins are admin-shaped within their tenant but are NOT platform-
  // shaped by default; only the bootstrap admin and credentials it
  // mints with `is_platform: true` may write platform-internal items.
  //
  // `core.*` writes are NOT gated here — core types are user-facing
  // (core.note, core.task, core.bookmark) and tenant admins write them
  // routinely; only registration of new core types is platform-gated
  // (see `routes/types.ts:331`).
  //
  // Reads to `system.*` / `marfa.*` are unrestricted (filtered by tenant
  // scoping at the storage layer); only writes need `is_platform`.
  //
  // Carve-out: runtime credentials (`is_runtime_credential: true`) may
  // write `system.activity`. That's the connector's status-reporting
  // channel — the activity sink in `runtime-sdk` calls `POST /items`
  // with `type: "system.activity"` to surface progress / errors for the
  // connection the credential is bound to. Without the carve-out a
  // legitimate connector can't emit activity rows.
  if (level === "write") {
    const tier = classifyNamespace(type);
    if ((tier === "system" || tier === "marfa") && !key.is_platform) {
      const isRuntimeActivityWrite =
        key.is_runtime_credential === true && type === "system.activity";
      if (!isRuntimeActivityWrite) {
        throw new MarfaError(
          ErrorCode.TYPE_NOT_PERMITTED,
          `Reserved namespace: only platform credentials may write ${tier}.* items`,
        );
      }
    }
  }

  // admin / tenant_admin bypass type_permissions — admin-shaped within the
  // tenant, with RLS + app-layer scoping as the isolation boundary. OAuth
  // (`scope_enforced`) keys do NOT bypass: they're held to granted scopes.
  if (roleBypassesPermissionMaps(key)) return;

  const resolved = resolveTypePermission(type, key.type_permissions);
  if (resolved === "none") {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `No access to type "${type}"`,
    );
  }
  if (level === "write" && resolved === "read") {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Write access to type "${type}" denied`,
    );
  }
}

export function computeTypeFilter(
  apiKey: ApiKey | undefined,
): string[] | undefined {
  // admin / tenant_admin see the full type surface; tenant isolation is
  // enforced separately at the storage layer. OAuth (`scope_enforced`) keys
  // fall through to their projected type_permissions (which carry the
  // granted wildcards) rather than seeing everything.
  if (!apiKey) return undefined;
  if (roleBypassesPermissionMaps(apiKey)) return undefined;

  const patterns: string[] = [];
  for (const [pattern, permission] of Object.entries(apiKey.type_permissions)) {
    if (permission === "read" || permission === "write") {
      patterns.push(pattern);
    }
  }
  return patterns; // empty means "no items visible", not "all items"
}

// ---------------------------------------------------------------------------
// Hono-specific wrappers
// ---------------------------------------------------------------------------

export function requireAuth(c: Context<AppEnv>): ApiKey {
  return checkAuth(c.get("apiKey"));
}

export function requireAdmin(c: Context<AppEnv>): ApiKey {
  return checkAdmin(c.get("apiKey"));
}

/**
 * Tenant-bounded admin gate. Admits `admin` (platform) OR `tenant_admin`
 * (tenant-bounded). See `checkTenantAdmin` for the safety contract:
 * the calling route MUST thread `key.tenant_id` into storage queries so a
 * tenant_admin cannot reach another tenant's resources via path id.
 */
export function requireTenantAdmin(c: Context<AppEnv>): ApiKey {
  return checkTenantAdmin(c.get("apiKey"));
}

export function requireTypeAccess(
  c: Context<AppEnv>,
  type: string,
  level: "read" | "write",
): void {
  checkTypeAccess(c.get("apiKey"), type, level);
}

/**
 * Enforces a per-edge-type permission check. Admin and tenant_admin
 * keys always pass (tenant_admin is admin-shaped within its tenant —
 * see `checkTypeAccess` for the layered-helper rationale). Non-admin
 * keys (member + OAuth-derived synthetic keys) need either the
 * specific edge-type permission or the `*` wildcard at the requested
 * level (write covers read).
 *
 * Throws EDGE_PERMISSION_DENIED (403) on failure — the discriminator
 * code lets SDK clients route `forbidden` differently from
 * specifically an edge-permission failure.
 */
export function requireEdgePermission(
  c: Context<AppEnv>,
  edgeType: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(c.get("apiKey"));
  if (roleBypassesPermissionMaps(apiKey)) return;
  if (edgePermissionCovers(apiKey.edge_permissions, edgeType, level)) return;
  throw new MarfaError(
    ErrorCode.EDGE_PERMISSION_DENIED,
    `Missing edge.${edgeType}:${level} permission`,
    { edge_type: edgeType, required: level },
  );
}

/**
 * Enforces a per-metadata-sub-resource permission check. Admin keys
 * always pass. Non-admin keys (including OAuth-derived synthetic keys)
 * need either the specific sub-resource permission or the `*` wildcard
 * at the requested level (write covers read).
 *
 * Throws FORBIDDEN (403) on failure with the missing scope name in the
 * error details so SDK clients can surface a precise re-auth prompt.
 */
export function requireMetadataPermission(
  c: Context<AppEnv>,
  subresource: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(c.get("apiKey"));
  // Same admin-tier shape as `requireEdgePermission`: tenant_admin is
  // admin-shaped within its tenant for metadata mutations too — except
  // OAuth (`scope_enforced`) keys, which must carry the granted scope
  // (`metadata.types:write` / `metadata.edge_types:write`). The
  // platform-credential gate on reserved-namespace type registration still
  // applies via the route-level `is_platform` check, not here.
  if (roleBypassesPermissionMaps(apiKey)) return;
  if (metadataPermissionCovers(apiKey.metadata_permissions, subresource, level))
    return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Missing metadata.${subresource}:${level} permission`,
    { metadata_subresource: subresource, required: level },
  );
}

export function getTypeFilter(c: Context<AppEnv>): string[] | undefined {
  return computeTypeFilter(c.get("apiKey"));
}
