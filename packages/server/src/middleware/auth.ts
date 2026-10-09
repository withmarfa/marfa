import {
  rememberReplayRequirement,
  rememberItemSubject,
} from "./replay-requirements.js";
import {
  rememberAuthorityPermission,
  rememberRecentAuthentication,
} from "../auth/request-authority.js";
import { createHmac } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Context, MiddlewareHandler } from "hono";
import {
  MarfaError,
  ErrorCode,
  classifyNamespace,
  resolveTypePermission,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToProfilePermissions,
  edgePermissionCovers,
  metadataPermissionCovers,
  hasPermission,
  resolveExtensionPermission,
} from "@withmarfa/shared";
import type { ApiKey, Permission, TypeFilter } from "@withmarfa/shared";
import type { OauthAccessTokenRow, Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";
import type { BoundCredential } from "../auth/live-credential.js";
import type { ReadViewAuthority } from "../storage/read-view.js";

// ---------------------------------------------------------------------------
// Hono environment type (shared across all routes)
// ---------------------------------------------------------------------------

// `extends Record<string, unknown>` is required by @hono/zod-openapi's router
// generic — pure interfaces don't satisfy it without the index signature.
export interface AppEnv extends Record<string, unknown> {
  Variables: {
    apiKey: ApiKey | undefined;
    authority: DirectAuthority | undefined;
    authType: "api_key" | "oauth" | undefined;

    oauthGrant:
      | {
          scopes: readonly string[];
          clientId: string;
          authUserId: string | null;
        }
      | undefined;
    boundCredential: BoundCredential | undefined;
    readViewAuthority: ReadViewAuthority | undefined;
    copyReadBoundary: MiddlewareHandler<AppEnv>;
    requestId: string;
    /**
     * The nonce this response's content security policy names, which an
     * inline script on a page it renders has to carry. One per request.
     */
    cspNonce: string;
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
  };
}

export type DirectAuthority =
  | Readonly<{ kind: "local_process" }>
  | Readonly<{
      kind: "owner";
      userId: string;
      sessionId: string;
      authenticatedAt: number;
    }>;

export function isDirectAuthority(c: Context<AppEnv>): boolean {
  return c.get("authority") !== undefined;
}

export function requireDirectAuthority(c: Context<AppEnv>): void {
  if (!isDirectAuthority(c)) {
    if (!c.get("apiKey"))
      throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "The owner or a local command must perform this operation",
    );
  }
}

export function requireRecentOwnerAuthentication(c: Context<AppEnv>): void {
  requireDirectAuthority(c);
  const authority = c.get("authority");
  if (!authority)
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  if (
    authority.kind === "owner" &&
    (Date.now() - authority.authenticatedAt > 300_000 ||
      authority.authenticatedAt > Date.now())
  ) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Sign in again to perform this operation",
    );
  }
  rememberRecentAuthentication();
}

/** An attribution handle, not a stored key or a transferable credential. */
export function authorityId(c: Context<AppEnv>): string {
  const authority = c.get("authority");
  if (authority?.kind === "local_process") return "local:process";
  if (authority?.kind === "owner") return `owner:${authority.sessionId}`;
  return requireAuth(c).id;
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
 * Narrow a validated credential row to the shape routes see on
 * `c.var.apiKey`.
 *
 * `KeyStore.validate` returns `ApiKey` plus the two fields only the
 * store needs — `key_hash`, which no route may ever see, and
 * `revoked_at`, which is already spent by the time validation returns.
 *
 * Subtractive on purpose. Rebuilding the object field by field would drop
 * every field added to `ApiKey` afterwards until someone remembered to
 * extend the list, and drop it silently: the types agree either way
 * because the missing fields are optional. `oauth_client_id` is the field
 * that shows what that costs: it is optional and stamped by the server, and
 * `GET /keys/current` answers this object, so a rebuild that forgot it would
 * present an app's key as an ordinary one.
 */
export function toRequestApiKey(
  stored: ApiKey & { key_hash: string; revoked_at: string | null },
): ApiKey {
  const key: Partial<typeof stored> = { ...stored };
  delete key.key_hash;
  delete key.revoked_at;
  return key as ApiKey;
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
 * conditional UPDATE in `OauthProviderStore.updateLastUsedAt`, writing only
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
 *   2. DB-side conditional UPDATE in `OauthProviderStore.updateLastUsedAt` —
 *      collapses concurrent writes from any number of instances to at
 *      most one row write per `DEBOUNCE_MS` per grant.
 *
 * Callers fire-and-forget — failures must never break the auth path.
 *
 * Used by:
 *   - `authMiddleware` for every authenticated bearer-bearing request.
 *   - The `/auth/oauth2/token` handlers, which issue tokens without
 *     resolving a bearer through the middleware.
 */
export async function stampOAuthGrantLastUsed(
  storage: Storage,
  connectionItemId: string,
): Promise<void> {
  const cacheKey = `oauth:${connectionItemId}`;
  const now = Date.now();
  const lastTracked = oauthLastUsedCache.get(cacheKey) ?? 0;
  if (now - lastTracked <= DEBOUNCE_MS) return;
  touchLastUsedCache(oauthLastUsedCache, cacheKey, now);
  try {
    await storage.oauthProvider?.updateLastUsedAt(
      connectionItemId,
      DEBOUNCE_MS,
    );
  } catch {
    // Best-effort; the cache mark above prevents a stampede.
  }
}

/**
 * Stamp `last_used_at` keyed by (clientId, authUserId)
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
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
    if (!itemId) return;
    await storage.oauthProvider?.updateLastUsedAt(itemId, DEBOUNCE_MS);
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

/**
 * The credential behind a request, named by something that survives a token
 * refresh: a key's id, or for a signed-in app its app and person,
 * `oauth:<client>:<user>`. Empty when the request carries no credential.
 *
 * An OAuth principal's `id` is the access-token row, and every refresh
 * replaces it, so anything that has to hold across a refresh keys on this:
 * an idempotent retry the app makes after refreshing, the bulk-action job
 * it comes back to read, and the rate limit, which it could otherwise reset
 * by refreshing.
 *
 * **A revoke followed by a fresh consent from the same app and person lands
 * on the same handle**, and an idempotent replay is served before the door's
 * authorization runs, so a narrower token of that pair sending the same
 * request under the same key is handed the first one's answer.
 */
export function credentialHandle(c: Context<AppEnv>): string {
  const apiKey = c.get("apiKey");
  if (isDirectAuthority(c)) return authorityId(c);
  if (apiKey === undefined) return "";
  return c.get("authType") === "oauth" ? apiKey.source : apiKey.id;
}

/**
 * The principal a sign-in's access token stands for, as every door reads
 * it, and as a bulk-action job reads it again before each chunk; null for a
 * token naming no person, which names no app and person a credential could
 * be and is refused as no credential at all.
 */
export function oauthPrincipal(oauthToken: OauthAccessTokenRow): ApiKey | null {
  if (oauthToken.userId === null) return null;
  const typePermissions = scopesToTypePermissions(oauthToken.scopes);
  const edgePermissions = scopesToEdgePermissions(oauthToken.scopes);
  const metadataPermissions = scopesToMetadataPermissions(oauthToken.scopes);
  const profilePermissions = scopesToProfilePermissions(oauthToken.scopes);
  // Stable composite label/source. Used in audit rows; doesn't need
  // to be a real foreign-key handle — system.connection projection
  // is maintained separately.
  const grantHandle = `${oauthToken.clientId}:${oauthToken.userId}`;
  const createdAtIso = oauthToken.createdAtMs
    ? new Date(oauthToken.createdAtMs).toISOString()
    : new Date().toISOString();
  // **No role is projected, because there is no role.** What the app may
  // do is the grant, which travels beside this principal rather than
  // inside it.
  return {
    id: oauthToken.id,
    label: `oauth:${grantHandle}`,
    source: `oauth:${grantHandle}`,
    // **A sign-in claims no source beyond its own.** A claim is granted
    // by a key's creator, and a grant is consent to scopes, none of
    // which names a source, so there is nothing an app was given that
    // a claim could come from.
    sources: [],
    default_tier: "library",
    // The permissions the door reads come from the grant beside this
    // principal rather than from here, because a grant is the live answer
    // and a projection would be a copy of it taken at request time.
    type_permissions: typePermissions,
    extension_permissions: {},
    edge_permissions: edgePermissions,
    metadata_permissions: metadataPermissions,
    profile_permissions: profilePermissions,
    created_at: createdAtIso,
    last_used_at: null,
  };
}

/**
 * **Nothing here reads how the instance was configured, and that is the
 * point.** What a caller may do turns on the credential in hand and never on
 * a deployment setting.
 *
 * **It resolves and never refuses.** This runs at `app.use("*")`, before
 * anything has matched a route, so it cannot know whether the door the
 * request is headed for wants a credential. Refusing belongs to the door,
 * and every route that declares one carries
 * {@link requireDeclaredCredential} for it.
 */
export function authMiddleware(storage: Storage, salt: string) {
  // Bounded LRU keyed by `key:<api-key-id>` for the stored-key path.
  // OAuth grants get their throttle from `oauthLastUsedCache` (module-
  // scoped) so route-handler stampers can share the same window.
  const lastUsedCache = new Map<string, number>();

  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("authority", undefined);
    c.set("boundCredential", undefined);

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
    // **Side-channel join, NOT custom claims.** The plugin's
    // `customAccessTokenClaims` only embeds in JWT tokens, and Marfa
    // keeps opaque tokens (correct for our profile — DB lookup is
    // sub-ms, revocation stays clean). The row itself carries `userId`,
    // `clientId`, and `scopes`. Everything the synthetic ApiKey needs
    // comes from the single row.
    //
    // **`connection_item_id` derivation.** The user-facing `system.connection`
    // projection (`{ kind: "app" }` items) is maintained by audited grant
    // lifecycle operations. We synthesize a stable label/source string
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

      const principal = oauthToken ? oauthPrincipal(oauthToken) : null;
      if (!oauthToken || !principal || oauthToken.userId === null) {
        c.set("apiKey", undefined);
        c.set("authType", undefined);
        return next();
      }

      c.set("boundCredential", {
        kind: "oauth",
        id: oauthToken.id,
        hash,
        clientId: oauthToken.clientId,
        authUserId: oauthToken.userId,
      });
      c.set("apiKey", principal);
      c.set("authType", "oauth");
      // The granted set, beside the projections rather than inside them.
      // Read only by `requirePermission` and by the audit rows that name
      // the grant an action was taken through.
      c.set("oauthGrant", {
        scopes: oauthToken.scopes,
        clientId: oauthToken.clientId,
        authUserId: oauthToken.userId,
      });

      if (oauthToken.userId) {
        void stampOAuthGrantLastUsedByGrantKey(storage, {
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

      c.set("boundCredential", { kind: "api_key", id: stored.id, hash });
      c.set("apiKey", toRequestApiKey(stored));
      c.set("authType", "api_key");

      // DB-side conditional UPDATE is the authoritative floor; this cache
      // skips the round-trip when this instance already wrote within DEBOUNCE_MS.
      const cacheKey = `key:${stored.id}`;
      const now = Date.now();
      const lastTracked = lastUsedCache.get(cacheKey) ?? 0;
      if (now - lastTracked > DEBOUNCE_MS) {
        await storage.keys.updateLastUsed(stored.id);
        touchLastUsedCache(lastUsedCache, cacheKey, now);
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

/**
 * Credential `source` prefixes a caller may not name for itself, as a key's
 * own source or as one it claims.
 *
 * `oauth:` is read as authority: the synthetic key an OAuth access token
 * produces is sourced `oauth:<clientId>:<userId>`, and it is synthesized
 * per request in this file, never persisted. A minted key carrying that
 * shape would read later as a grant it has no binding to.
 */
export const RESERVED_CREDENTIAL_SOURCE_PREFIXES = ["oauth:"] as const;

/** Whether `source` claims a reserved prefix. */
export function isReservedCredentialSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  return RESERVED_CREDENTIAL_SOURCE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function checkAuth(apiKey: ApiKey | undefined): ApiKey {
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }
  return apiKey;
}

export function mayWriteReserved(_key: ApiKey, type: string): boolean {
  return classifyNamespace(type) !== "system";
}

/**
 * Whether this credential may create an edge of `edgeType` from a
 * `sourceType` row to a `targetType` row, as `POST /edges` decides.
 */
export function mayWriteEdge(
  key: ApiKey,
  edgeType: string,
  sourceType: string,
  targetType: string,
): boolean {
  return (
    mayWriteReserved(key, sourceType) &&
    resolveTypePermission(sourceType, key.type_permissions) === "write" &&
    edgePermissionCovers(key.edge_permissions, edgeType, "write") &&
    mayReadType(key, targetType)
  );
}

/**
 * Whether this credential may read this type.
 *
 * The decision `checkTypeAccess` throws over at `read`, as a question a
 * caller can ask without being refused for asking. A listing needs it:
 * a page is a page of what the caller may see, so a row it may not read
 * is dropped rather than turned into a refusal of the whole page.
 *
 * One reading rather than two, because a listing and a point check that
 * disagree about one credential is a disclosure: the plural door hands
 * over what the singular one refuses, and nothing in either answer says
 * they disagree.
 */
export function mayReadType(key: ApiKey, type: string): boolean {
  return resolveTypePermission(type, key.type_permissions) !== "none";
}

export function checkTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);

  if (level === "write" && !mayWriteReserved(key, type)) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Reserved namespace: platform-managed operations write system.* items; credentials cannot write them directly.`,
    );
  }

  checkTypePermission(key, type, level);
  rememberReplayRequirement({
    kind: "type",
    type,
    level,
    permissionOnly: false,
  });
}

/**
 * The credential's own type map, without the reserved-namespace fence
 * `checkTypeAccess` puts in front of it. The folder doors write through this
 * map, as does purge for a reserved row already soft-deleted: no credential
 * gets past the fence and the map both, so the fence would strand that row.
 */
export function checkTypePermission(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);
  if (!mayReadType(key, type)) {
    throw grantRefusal(
      ErrorCode.TYPE_NOT_PERMITTED,
      `No access to type "${type}"`,
      { kind: "type", name: type, level },
    );
  }
  rememberReplayRequirement({
    kind: "type",
    type,
    level,
    permissionOnly: true,
  });
  const resolved = resolveTypePermission(type, key.type_permissions);
  if (level === "write" && resolved === "read") {
    throw grantRefusal(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Write access to type "${type}" denied`,
      { kind: "type", name: type, level },
    );
  }
}

/** The grant a refusal is about: what a key lacks, so a client holding a
 *  write the refusal stopped can tell a narrowed key from a write that will
 *  never land, and send it again once the grant is back. */
export interface MissingGrant {
  kind: "type" | "edge_type" | "extension";
  /** The type or edge type's identifier, or the extension namespace. */
  name: string;
  /** The level the key lacks, which is the level the door asked for. */
  level: "read" | "write";
}

/**
 * A refusal caused by a grant the key does not hold, naming it in
 * `details.grant`. Every refusal of that kind is built here, and nothing
 * else carries the field: the reserved-namespace fence and a natural key
 * resolving a row the key may not read are refused for other reasons and
 * name no grant, the first because no grant opens it and the second
 * because naming the type would disclose the row.
 */
export function grantRefusal(
  code: ErrorCode,
  message: string,
  grant: MissingGrant,
  details: Record<string, unknown> = {},
): MarfaError {
  return new MarfaError(code, message, { ...details, grant });
}

/** The key's grant on an extension namespace, at `level`. */
export function checkExtensionPermission(
  apiKey: ApiKey | undefined,
  namespace: string,
  level: "read" | "write",
): void {
  const perm = resolveExtensionPermission(
    namespace,
    apiKey?.extension_permissions,
  );
  if (perm === "write" || (level === "read" && perm === "read")) {
    rememberReplayRequirement({ kind: "extension", namespace, level });
    return;
  }
  throw grantRefusal(
    ErrorCode.FORBIDDEN,
    `No ${level} access to extension namespace "${namespace}"`,
    { kind: "extension", name: namespace, level },
  );
}

/**
 * What a credential may reach at a given level, as a list query can express it.
 *
 * **Returns a pair, and that is the point.** `allowed` alone cannot say what
 * a permission map says: a `"none"` entry subtracts, and a filter assembled
 * from the granted patterns has no way to state a subtraction. Approximating
 * it, by enumerating the global wildcard into the concrete ids it stands for
 * minus the excluded ones, leaks in both directions. A subtree grant with an
 * exclusion nested beneath it, `{"user.*": "read", "user.secret": "none"}`,
 * carries no global wildcard, so it would pass through whole and list the one
 * type it exists to withhold. And rows orphaned by
 * `DELETE /types/{id}?force=true`, the registration dropped and the items
 * deliberately kept, cannot appear in an enumeration over the registry, so
 * they would vanish from every listing while the point check still served
 * them by id.
 *
 * Both are the same failure: a list filter and a point check that disagree.
 * `excluded_types` states the subtraction instead of approximating it, so
 * neither shape has anywhere to hide, and nothing depends on the registry
 * naming every type.
 *
 * **The pair rather than a second function beside this one is deliberate.** A
 * call site that took the permitted list without the exclusions would fail
 * open, which is the defect above reintroduced one layer up, and it would do
 * so silently — every suite that does not mint an exclusion-carrying key
 * would still pass. Returning one object makes it unrepresentable: a call
 * site cannot forget a field it has to destructure.
 *
 * `allowed: undefined` keeps meaning "no restriction" and `allowed: []` keeps
 * meaning "nothing visible", so the contract at every call site survives.
 */
export function computeTypeFilter(
  apiKey: ApiKey | undefined,
  /**
   * Which grants count as permitting a type.
   *
   * `"read"` is the default, and it is right for a listing: a caller may see
   * anything it may read or write. A door that *writes* what it matched has
   * to ask the narrower question. `POST /items/bulk-actions` is filter-in
   * with no per-row permission check, so asked at `"read"` a key granted
   * read across the board would arrive with nothing narrowed and then write
   * to everything it matched.
   *
   * A read-only grant lands in `excluded` rather than merely being left out
   * of `allowed`, because a broader pattern would otherwise readmit it:
   * `{"*": "write", "user.secret": "read"}` has to subtract the literal or
   * the wildcard covers it.
   */
  level: "read" | "write" = "read",
): TypeFilter {
  // Nothing bypasses this map. A sign-in's granted scopes project into the
  // same `type_permissions`, so one shape of credential arrives here and the
  // map is the whole answer.
  // A fresh object each time rather than one shared constant: these travel
  // into storage filters, and a shared literal is a mutation hazard nobody
  // would think to look for.
  if (!apiKey) return { allowed: undefined, excluded: [] };
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const [pattern, permission] of Object.entries(apiKey.type_permissions)) {
    if (permission === "write" || (level === "read" && permission === "read")) {
      allowed.push(pattern);
    } else {
      // Anything that is not a grant is an exclusion. An `else` rather than a
      // third `=== "none"` comparison, which the compiler believes is always
      // true and the linter therefore rejects — but that belief is a
      // compile-time fiction here. The stored map arrives through an
      // unchecked cast (`safeJsonParse<Record<string, TypePermission>>` in
      // both key stores); the `z.enum` on POST /keys guards the write and
      // nothing checks membership on the read. So a junk stored value reaches
      // this arm, and reaching it means the map is not read as granting that
      // pattern. It narrows the result rather than widening it, which is the
      // conservative direction to be wrong in.
      excluded.push(pattern);
    }
  }
  // Empty `allowed` means "no items visible", not "all items".
  return { allowed, excluded };
}

// ---------------------------------------------------------------------------
// Hono-specific wrappers
// ---------------------------------------------------------------------------

export function requireAuth(c: Context<AppEnv>): ApiKey {
  return checkAuth(c.get("apiKey"));
}

const standingRules = new WeakMap<object, string>();

/** The standing rule a route handler holds, if it is one of these. */
export function standingRuleOf(handler: unknown): string | undefined {
  return typeof handler === "function" ? standingRules.get(handler) : undefined;
}

export function standingRule(
  name: string,
  check: (c: Context<AppEnv>) => void,
): MiddlewareHandler<AppEnv> {
  const rule = createMiddleware<AppEnv>(async (c, next) => {
    check(c);
    await next();
  });
  standingRules.set(rule, name);
  return rule;
}

/** Owner-session or private local transport, never an app permission. */
export const directAuthorityOnly = standingRule(
  "owner or local command",
  requireDirectAuthority,
);

export const readsSomeType = standingRule("reads some type", (c) => {
  getTypeFilter(c);
});

/** Only a key opens the door: a signed-in app's token is refused `403`. */
export const keysOnly = standingRule("a key, not a signed-in app", (c) => {
  requireAuth(c);
  if (c.get("authType") === "oauth") {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "This credential is a signed-in app's token, not a key; its reach is its grant.",
    );
  }
});

/** Explicit permission or the directly authenticated owner/local process. */
export function standingPermission(
  permission: Permission,
): MiddlewareHandler<AppEnv> {
  return standingRule(permission, (c) => {
    requirePermission(c, permission);
  });
}

export const requireDeclaredCredential = createMiddleware<AppEnv>(
  async (c, next) => {
    if (!isDirectAuthority(c)) checkAuth(c.get("apiKey"));
    await next();
  },
);

export function requireTypeAccess(
  c: Context<AppEnv>,
  type: string | { id: string; type: string },
  level: "read" | "write",
): void {
  checkTypeAccess(
    c.get("apiKey"),
    typeof type === "string" ? type : type.type,
    level,
  );
  if (typeof type !== "string") rememberItemSubject(type, level);
}

/**
 * The row a door names by id, answered as its `notFound` where the key cannot
 * read its type, so a hidden row and no row look alike to the caller.
 */
export function requireReadableRow<T extends { type: string }>(
  c: Context<AppEnv>,
  row: T | null | undefined,
  notFound: () => MarfaError,
): T {
  getTypeFilter(c);
  if (!row || !mayReadRow(c, row)) throw notFound();
  if ("id" in row && typeof row.id === "string")
    rememberItemSubject({ id: row.id, type: row.type }, "read");
  return row;
}

/**
 * Write access to a row a natural key resolved, refused without naming the
 * row where the credential may not read its type.
 *
 * **A key learns nothing about a row it may not read.** A natural key names
 * a row by the source and `source_id` the caller chose, so a key sharing a
 * source with another (`keys-and-oauth/claims-answered`) reaches rows of types it holds
 * nothing on, and the refusal it gets is all it learns: that its key is
 * taken, which it needs, and not the row's id or any field of it, its type
 * included. `requireTypeAccess` names the type it refuses, which is right
 * where the caller named it and a disclosure where a key resolved it.
 */
export function requireResolvedRowWrite(
  c: Context<AppEnv>,
  row: { type: string },
): void {
  checkResolvedRowWrite(c.get("apiKey"), row);
}

/** `requireResolvedRowWrite` for a credential in hand. */
export function checkResolvedRowWrite(
  apiKey: ApiKey | undefined,
  row: { type: string },
): void {
  if (!mayReadType(checkAuth(apiKey), row.type)) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "The natural key resolves a row of a type this credential may not reach",
    );
  }
  checkTypeAccess(apiKey, row.type, "write");
}

/**
 * The row a write door names by id, refused as its `notFound` where it is
 * missing, where the key may not read its type, and where it is in the bin.
 * A row in the bin is refused with `details.trashed` to a key that may read
 * its type, so a client holding a write to it can tell a row someone deleted
 * from one that never existed, and offer it back; to any other key the two
 * read alike.
 */
export function checkWritableRow<T extends { type: string; state: string }>(
  apiKey: ApiKey | undefined,
  row: T | null | undefined,
  notFound: () => MarfaError,
): T {
  const key = checkAuth(apiKey);
  return writableRowOf(row, (type) => mayReadType(key, type), notFound);
}

/** `checkWritableRow` for a writer that answers what it may read. */
export function writableRowOf<T extends { type: string; state: string }>(
  row: T | null | undefined,
  mayRead: (type: string) => boolean,
  notFound: () => MarfaError,
): T {
  if (!row || !mayRead(row.type)) throw notFound();
  if (row.state === "trashed") {
    const refusal = notFound();
    throw new MarfaError(refusal.code, refusal.message, {
      ...refusal.details,
      trashed: true,
    });
  }
  return row;
}

/** `checkWritableRow` for the request's credential, refusing first a
 *  credential whose type map reaches no type, as a read door does. */
export function requireWritableRow<T extends { type: string; state: string }>(
  c: Context<AppEnv>,
  row: T | null | undefined,
  notFound: () => MarfaError,
): T {
  getTypeFilter(c);
  return checkWritableRow(c.get("apiKey"), row, notFound);
}

/** Whether the credential may read this row's type. */
export function mayReadRow(c: Context<AppEnv>, row: { type: string }): boolean {
  return mayReadType(checkAuth(c.get("apiKey")), row.type);
}

/** Whether the credential may read a type, as a function to hand on. */
export function typeReader(c: Context<AppEnv>): (type: string) => boolean {
  const key = checkAuth(c.get("apiKey"));
  return (type) => mayReadType(key, type);
}

/**
 * Whether the credential may read an edge end of this type. An edge write
 * answers an end it may not read exactly as a missing one.
 */
export function mayReadEdgeEnd(c: Context<AppEnv>): (type: string) => boolean {
  return typeReader(c);
}

/**
 * The `source` an item written by this credential is keyed by and stamped
 * with, given the one the write names.
 *
 * A write naming none, or the credential's own, takes the credential's own.
 * A write naming one of the credential's claimed `sources` takes that one,
 * which is what lets two keys present one natural key: two devices enrolled
 * with their own keys, both claiming a folder's source, write the same file
 * as the same row. Anything else is refused rather than stamped, because a
 * row's source is its provenance and the half of its natural key a caller
 * does not choose freely: a named source nobody gave this credential would
 * let any key write rows that read as another's, and upsert onto them.
 *
 * The one resolution both create doors use, so a single create and a bulk
 * entry cannot disagree about what a body may name.
 */
export function itemProvenanceSource(
  key: ApiKey | undefined,
  named?: string,
  origin: "request" | "subject" = "request",
): string | undefined {
  if (named === undefined) return key?.source;
  if (named === key?.source) {
    rememberReplayRequirement({
      kind: "source",
      source: named,
      identifierDisclosed: origin === "request",
    });
    return key.source;
  }
  if (key?.sources?.includes(named) === true) {
    rememberReplayRequirement({
      kind: "source",
      source: named,
      identifierDisclosed: origin === "request",
    });
    return named;
  }
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `This credential may not write under the source "${named}". A write names its own credential's source or one that credential claims.`,
    { source: named },
  );
}

/**
 * The type a write declares is the type it lands on, or the write is
 * refused.
 *
 * Most doors address a row by something other than its type, a natural
 * key or an id, and carry a `type` in the body that plays no part in
 * finding it. Merging the submitted properties onto whatever the key
 * resolved would reinterpret a caller that declared one type and resolved
 * another, with a 200 and nothing said, rather than refuse it.
 *
 * Two doors are exempt and neither by omission. `POST /items` create
 * resolves no row, so the type it names IS the row. `bulk-actions`
 * selects by filter, where a type is a selector and cannot disagree with
 * what it selected.
 *
 * Refusing here rather than in each caller is deliberate. A caller that
 * addresses a row by an id it cached, or hands a page to a bulk upsert,
 * has no reason to read the row's type before writing, so there is no
 * caller-side defense to defer to. The door is the only place the
 * disagreement can be seen at all, which is also why it does not care why
 * the two types differ: a type a caller derives fresh on every run from
 * configuration the user can change is the likeliest source, and no
 * caller is in a position to notice.
 *
 * Called from each door that resolves a row it did not create; the
 * door-coverage tests pin the set.
 */
export function requireDeclaredTypeMatches(
  declared: string,
  row: { id: string; type: string },
): void {
  // Exact, not subtype-aware, and that is a choice rather than an
  // oversight. Admitting an ancestor would soften the one failure this
  // causes — a write family moved from a specific type to the core one
  // it descends from would keep syncing — but it also makes the declared
  // type unfalsifiable for every type with descendants. The claim is either
  // the row's type or it is not, and a caller that means to move a corpus
  // between types has an operation for it.
  if (declared === row.type) return;
  throw new MarfaError(
    ErrorCode.TYPE_MISMATCH,
    `Request declares type "${declared}" but resolves an item of type "${row.type}"; a write does not re-type the row it lands on`,
    { item_id: row.id, declared_type: declared, actual_type: row.type },
  );
}

/**
 * Enforces a per-edge-type permission check. Every credential needs either
 * the specific edge-type permission or the `*` wildcard at the requested
 * level (write covers read), and nothing passes without one.
 *
 * Throws EDGE_PERMISSION_DENIED (403) on failure — the discriminator
 * code lets a client route `forbidden` differently from
 * specifically an edge-permission failure.
 */
export function requireEdgePermission(
  c: Context<AppEnv>,
  edgeType: string,
  level: "read" | "write",
): void {
  checkEdgePermission(c.get("apiKey"), edgeType, level);
}

/** `requireEdgePermission` for a credential in hand. */
export function checkEdgePermission(
  key: ApiKey | undefined,
  edgeType: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(key);
  if (edgePermissionCovers(apiKey.edge_permissions, edgeType, level)) {
    rememberReplayRequirement({ kind: "edge_type", edgeType, level });
    return;
  }
  throw grantRefusal(
    ErrorCode.EDGE_PERMISSION_DENIED,
    `Missing edge.${edgeType}:${level} permission`,
    { kind: "edge_type", name: edgeType, level },
    { edge_type: edgeType, required: level },
  );
}

/**
 * Enforces a per-metadata-sub-resource permission check. Every credential
 * needs either the specific sub-resource permission or the `*` wildcard at
 * the requested level (write covers read), and nothing passes without one.
 *
 * Throws FORBIDDEN (403) on failure with the missing scope name in the
 * error details so a client can surface a precise re-auth prompt.
 */
export function requireMetadataPermission(
  c: Context<AppEnv>,
  subresource: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(c.get("apiKey"));
  if (
    metadataPermissionCovers(apiKey.metadata_permissions, subresource, level)
  ) {
    rememberReplayRequirement({ kind: "metadata", subresource, level });
    return;
  }
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Missing metadata.${subresource}:${level} permission`,
    { metadata_subresource: subresource, required: level },
  );
}

export function requirePermission(
  c: Context<AppEnv>,
  permission: Permission,
): void {
  if (holdsPermission(c, permission)) {
    rememberAuthorityPermission(permission);
    rememberReplayRequirement({ kind: "permission", permission });
    return;
  }
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `This credential does not hold ${permission}`,
    { required_scope: permission },
  );
}

/**
 * Whether the credential holds `permission`, asked without being refused for
 * asking: a door that admits a credential on one of two grounds has to tell
 * which it holds. {@link requirePermission} is the question with the refusal
 * and the replay record, and a door that goes on to rely on the answer asks
 * it too.
 *
 * **One question, asked of one list, whichever kind of credential arrived.**
 * A key carries its permissions on its row and a sign-in carries them on its
 * grant, and both are the literals themselves, so there is no second
 * implementation to drift. A missing carrier fails closed.
 */
export function holdsPermission(
  c: Context<AppEnv>,
  permission: Permission,
): boolean {
  if (isDirectAuthority(c)) return true;
  const key = checkAuth(c.get("apiKey"));
  const held =
    c.get("authType") === "oauth"
      ? (c.get("oauthGrant")?.scopes ?? [])
      : (key.permissions ?? []);
  return hasPermission(held, permission);
}

/** Whether the credential's metadata map covers `subresource` at `level`,
 *  asked without being refused for asking. */
export function holdsMetadataPermission(
  c: Context<AppEnv>,
  subresource: string,
  level: "read" | "write",
): boolean {
  return metadataPermissionCovers(
    checkAuth(c.get("apiKey")).metadata_permissions,
    subresource,
    level,
  );
}

/**
 * The filter a data-plane read narrows by, refusing a credential the map
 * leaves nowhere to look.
 *
 * An empty `allowed` at read level is a credential that may read no type
 * at all. Answering it `200` with an empty page says "there is nothing
 * here", which is not what happened: there is a great deal here and this
 * credential may not see it. The single-row doors refuse it too, through
 * `requireReadableRow`, so one question gets one answer however many rows.
 *
 * **Only at read level.** `POST /items/bulk-actions` also asks at
 * `"write"`, where it narrows a match set rather than refusing a row, so a
 * key that reads every type and writes none matches nothing there. A key
 * reaching no type at all is refused that door first, by `readsSomeType`.
 *
 * **In the wrapper and not in `computeTypeFilter`**, which stays a pure
 * predicate for the callers that answer an empty reach their own way.
 */
export function getTypeFilter(
  c: Context<AppEnv>,
  level: "read" | "write" = "read",
): TypeFilter {
  const filter = computeTypeFilter(c.get("apiKey"), level);
  if (level === "read") {
    refuseReachingNoType(filter);
    rememberReplayRequirement({ kind: "reach" });
  }
  return filter;
}

/** `getTypeFilter`'s refusal, for a credential in hand. */
export function checkReachesSomeType(apiKey: ApiKey | undefined): void {
  refuseReachingNoType(computeTypeFilter(apiKey));
  rememberReplayRequirement({ kind: "reach" });
}

function refuseReachingNoType(filter: TypeFilter): void {
  // `allowed === undefined` is "no credential at all" and nothing else;
  // the doors that reach here have already required one.
  if (filter.allowed?.length === 0) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "This credential's type permissions reach no type, so there is nothing on the data plane it may read.",
    );
  }
}
