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
  scopesToProfilePermissions,
  edgePermissionCovers,
  metadataPermissionCovers,
  hasPermission,
} from "@withmarfa/shared";
import type { ApiKey, Permission, TypeFilter } from "@withmarfa/shared";
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
    /**
     * The OAuth grant behind this request, as granted. Set only for an
     * OAuth bearer; `undefined` for an API key, for an anonymous request,
     * and for bootstrap.
     *
     * **The scopes are here because they reach no permission map.** The
     * four projections beside them translate a token's scopes into
     * `type_permissions`, `edge_permissions`, `metadata_permissions` and
     * `profile_permissions`
     * and drop every literal they do not recognize — deliberately, since a
     * permission names authority over an administrative surface rather
     * than over a resource, and admitting one into a projection would put
     * it on the data plane where a wildcard could reach it. So the granted
     * set has to travel beside the projections rather than through them,
     * and `requirePermission` is the only thing that reads it.
     *
     * `clientId` and `authUserId` are here for a second reason: an audit
     * row for an action an app took needs to name the grant it was taken
     * through, and the synthetic key carries them only baked into a
     * composite `label` / `source` string. Parsing that string back apart
     * would make the row's meaning depend on a display format.
     */
    oauthGrant:
      | {
          scopes: readonly string[];
          clientId: string;
          authUserId: string | null;
        }
      | undefined;
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
 * that shows what that costs — it is optional, it is stamped by the server
 * rather than asked for, and `extensionLabelOf` refuses a label claim on
 * it, so a rebuild that forgot it would hand every app-minted key a label
 * it may not have. Naming what to remove fails closed on the next field;
 * naming what to keep fails open.
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
    // Bootstrap detection: POST /keys on an instance that has never
    // had a key. The gate is a persistent `settings.bootstrapped`
    // sentinel, NOT a live `keys.count() === 0` check — revoking every
    // key must not re-open bootstrap (would let an unauthenticated
    // caller mint the operator key and take over the instance).
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
    // **Side-channel join, NOT custom claims.** The plugin's
    // `customAccessTokenClaims` only embeds in JWT tokens, and Marfa
    // keeps opaque tokens (correct for our profile — DB lookup is
    // sub-ms, revocation stays clean). The row itself carries `userId`,
    // `clientId`, and `scopes`. Everything the synthetic ApiKey needs
    // comes from the single row.
    //
    // **`connection_item_id` derivation.** The user-facing `system.connection`
    // projection (`{ kind: "app" }` items) is maintained by the
    // grant-projection after-hooks for the `/security` page surface,
    // not consulted here. We synthesize a stable label/source string
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
      const profilePermissions = scopesToProfilePermissions(oauthToken.scopes);
      // Stable composite label/source. Used in audit rows; doesn't need
      // to be a real foreign-key handle — system.connection projection
      // is maintained separately.
      const grantHandle = `${oauthToken.clientId}:${oauthToken.userId ?? "anon"}`;
      const createdAtIso = oauthToken.createdAtMs
        ? new Date(oauthToken.createdAtMs).toISOString()
        : new Date().toISOString();
      // **No role is projected, because there is no role.** What the app may
      // do is the grant, which travels beside this principal rather than
      // inside it.
      c.set("apiKey", {
        id: oauthToken.id,
        label: `oauth:${grantHandle}`,
        source: `oauth:${grantHandle}`,
        // **A sign-in claims no source beyond its own.** A claim is granted
        // by a key's creator, and a grant is consent to scopes, none of
        // which names a source, so there is nothing an app was given that
        // a claim could come from.
        sources: [],
        default_tier: "library",
        // **An operator key is never derivable from a sign-in.** Running the
        // instance sits outside the permission model, so no consent screen can
        // offer it and no grant can reach it.
        is_operator: false,
        // The permissions the door reads come from the grant beside this
        // principal rather than from here, because a grant is the live answer
        // and a projection would be a copy of it taken at request time.
        //
        // The client is named on the principal because one thing downstream
        // needs to know an app chose this credential's label rather than an
        // operator: see `extensionLabelOf`.
        oauth_client_id: oauthToken.clientId,
        type_permissions: typePermissions,
        extension_permissions: {},
        edge_permissions: edgePermissions,
        metadata_permissions: metadataPermissions,
        profile_permissions: profilePermissions,
        created_at: createdAtIso,
        last_used_at: null,
      });
      c.set("authType", "oauth");
      // The granted set, beside the projections rather than inside them.
      // Read only by `requirePermission` and by the audit rows that name
      // the grant an action was taken through.
      c.set("oauthGrant", {
        scopes: oauthToken.scopes,
        clientId: oauthToken.clientId,
        authUserId: oauthToken.userId ?? null,
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

      c.set("apiKey", toRequestApiKey(stored));
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

/**
 * Credential `source` prefixes a caller may not name for itself, as a key's
 * own source or as one it claims.
 *
 * A caller-supplied `source` is free text, and two readers give it a
 * meaning, so the reservation covers both.
 *
 * `oauth:` is read as authority: the synthetic key an OAuth access token
 * produces is sourced `oauth:<clientId>:<userId>`, and it is synthesized
 * per request in this file, never persisted. A minted key carrying that
 * shape would read later as a grant it has no binding to.
 *
 * `connector:` is read as provenance. `itemProvenanceSource` stamps a
 * credential's source, or one it claims, onto every row it writes, so a
 * minted key carrying or claiming the prefix would put the mark of a
 * connector on rows a caller wrote by hand. The connector registry
 * (`connectors.md`) is where a connector is declared; a credential source
 * is not, and the reservation is what keeps the two from being confusable.
 */
export const RESERVED_CREDENTIAL_SOURCE_PREFIXES = [
  "oauth:",
  "connector:",
] as const;

/** Whether `source` claims one of the reserved connector shapes. */
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

/**
 * Operator gate. Guards the surfaces whose authority is instance-wide:
 * key minting, instance metrics, archive restore, blob reconciliation.
 *
 * **Running the instance is not a permission**, which is why this reads a
 * field on the row rather than a member of the permission set. The operator
 * key is fenced outside the model deliberately: it is never offered on a
 * consent screen, never derivable from a sign-in, and never needed by an app.
 * A surface that belongs inside the permission model wants
 * `requirePermission` instead.
 */
export function checkOperatorKey(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (!key.is_operator) {
    throw new MarfaError(ErrorCode.FORBIDDEN, "Operator key required");
  }
  return key;
}

/**
 * Whether this credential may write a row in a reserved namespace.
 *
 * The predicate form of the fence `checkTypeAccess` applies, extracted
 * because a second door needs to ask the same question without throwing:
 * `POST /items/bulk-actions` narrows a match set rather than refusing a
 * row, so it has to *ask* what this decides rather than be told by an
 * exception. Restating it there would have been a second copy of the one
 * rule that decides who reaches the platform's own rows.
 *
 * The operator key passes outright; nothing else writes `system.*` or
 * `marfa.*`.
 */
export function mayWriteReserved(key: ApiKey, type: string): boolean {
  if (key.is_operator) return true;
  const tier = classifyNamespace(type);
  return tier !== "system" && tier !== "marfa";
}

/**
 * Whether this credential may create an edge of `edgeType` from a
 * `sourceType` row, as `POST /edges` decides.
 */
export function mayWriteEdge(
  key: ApiKey,
  edgeType: string,
  sourceType: string,
): boolean {
  return (
    mayWriteReserved(key, sourceType) &&
    resolveTypePermission(sourceType, key.type_permissions) === "write" &&
    edgePermissionCovers(key.edge_permissions, edgeType, "write")
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

  // Operator gate. Writes to `system.*` (and the internal-only `marfa.*`)
  // require `is_operator: true`, which is the instance tier and nothing a
  // working credential can hold. It is a fence rather than a route: the
  // operator key's own maps are empty, so in practice the platform's own
  // machinery writes these rows through the storage layer rather than through
  // a credential at all.
  //
  // **The message says no credential rather than naming the operator key.**
  // The operator key is the only credential this fence admits, and the
  // permission resolution below then refuses it too:
  // `api_keys_operator_holds_nothing` makes an operator key's
  // `type_permissions` empty by database constraint, so the map resolves
  // `none`. Naming a door and refusing everyone who walks through it would
  // send readers looking for a credential to mint.
  //
  // `core.*` writes are NOT gated here — core types are user-facing
  // (core.note, core.task, core.bookmark) and ordinary credentials write them
  // routinely. Registering a new one is a different matter: `routes/types.ts`
  // refuses a reserved root to every credential, the operator key included,
  // because the shipped vocabulary is a property of the build.
  //
  // Only writes are gated. A read of `system.*` or `marfa.*` is bounded by
  // the caller's own type permissions like any other read, so there is
  // nothing left for this check to add on that side.
  if (level === "write") {
    const tier = classifyNamespace(type);
    if (
      (tier === "system" || tier === "marfa") &&
      !mayWriteReserved(key, type)
    ) {
      throw new MarfaError(
        ErrorCode.TYPE_NOT_PERMITTED,
        `Reserved namespace: no credential writes ${tier}.* items. The operator key is the only one this fence admits and it holds no type permissions, so the platform writes these rows through the storage layer instead.`,
      );
    }
  }

  checkTypePermission(key, type, level);
}

/**
 * The credential's own type map, without the reserved-namespace fence
 * `checkTypeAccess` puts in front of it. Only the purge door wants this half
 * alone, for a reserved row already soft-deleted: no credential gets past
 * the fence and the map both, so the fence would strand the row.
 */
export function checkTypePermission(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);
  if (!mayReadType(key, type)) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `No access to type "${type}"`,
    );
  }
  const resolved = resolveTypePermission(type, key.type_permissions);
  if (level === "write" && resolved === "read") {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Write access to type "${type}" denied`,
    );
  }
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
 * site cannot forget a field it has to destructure. (`refuseNarrowCredential`
 * in `routes/webhooks.ts` asks this function directly rather than through
 * `getTypeFilter`: it reads both `allowed` and `excluded`, the pair this
 * reasoning is about, and asks here so that it answers its own code.)
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

export function requireOperatorKey(c: Context<AppEnv>): ApiKey {
  return checkOperatorKey(c.get("apiKey"));
}

/**
 * The credential check as a route's own middleware, hung off every route
 * whose `security` declares one by `createOpenAPIRouter`.
 *
 * **A door that asks for a credential must answer the missing one first.**
 * A refusal inside a handler is reached only after the router has validated
 * the request and after the handler has read its row, so what a bare request
 * is told depends on what else is wrong with it — and a `404` for a row that
 * is not there tells a caller holding nothing which ids exist. This runs
 * ahead of the validators and ahead of the handler, so one bare request gets
 * one answer.
 *
 * Bootstrap is the one credential-less caller a declared door admits: the
 * first `POST /keys` on an instance that has never held a key presents the
 * one-time secret from the boot log instead, and `authMiddleware` marks the
 * request rather than resolving a credential for it.
 */
export const requireDeclaredCredential = createMiddleware<AppEnv>(
  async (c, next) => {
    if (!c.get("isBootstrap")) checkAuth(c.get("apiKey"));
    await next();
  },
);

export function requireTypeAccess(
  c: Context<AppEnv>,
  type: string,
  level: "read" | "write",
): void {
  checkTypeAccess(c.get("apiKey"), type, level);
}

/**
 * Write access to a row a natural key resolved, refused without naming the
 * row where the credential may not read its type.
 *
 * **A key learns nothing about a row it may not read.** A natural key names
 * a row by the source and `source_id` the caller chose, so a key sharing a
 * source with another (`keys-and-oauth.md` 34) reaches rows of types it holds
 * nothing on, and the refusal it gets is all it learns: that its key is
 * taken, which it needs, and not the row's id or any field of it, its type
 * included. `requireTypeAccess` names the type it refuses, which is right
 * where the caller named it and a disclosure where a key resolved it.
 */
export function requireResolvedRowWrite(
  c: Context<AppEnv>,
  row: { type: string },
): void {
  if (!mayReadResolvedRow(c, row)) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "The natural key resolves a row of a type this credential may not reach",
    );
  }
  requireTypeAccess(c, row.type, "write");
}

/** Whether the credential may read a row a natural key resolved. */
export function mayReadResolvedRow(
  c: Context<AppEnv>,
  row: { type: string },
): boolean {
  return mayReadType(checkAuth(c.get("apiKey")), row.type);
}

/**
 * Whether the credential may read an edge target of this type. An edge write
 * answers a target it may not read exactly as a missing one.
 */
export function mayReadEdgeTarget(
  c: Context<AppEnv>,
): (type: string) => boolean {
  const key = checkAuth(c.get("apiKey"));
  return (type) => mayReadType(key, type);
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
): string | undefined {
  if (named === undefined || named === key?.source) return key?.source;
  if (key?.sources?.includes(named) === true) return named;
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
  const apiKey = checkAuth(c.get("apiKey"));
  if (edgePermissionCovers(apiKey.edge_permissions, edgeType, level)) return;
  throw new MarfaError(
    ErrorCode.EDGE_PERMISSION_DENIED,
    `Missing edge.${edgeType}:${level} permission`,
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
  // The same shape as `requireEdgePermission`, and for the same reason: a
  // credential's map is the whole of what it may reach, whether it was minted
  // as a key or projected from a grant. Namespace
  // rules are the route's, not this gate's: reserved roots (`core.*`,
  // `system.*`, `marfa.*`) are refused at registration for every
  // credential, operator included. A `publisher.*` namespace binds to
  // nobody: user accounts carry no handle and no door compares one, so it
  // registers on the grammar alone.
  if (metadataPermissionCovers(apiKey.metadata_permissions, subresource, level))
    return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Missing metadata.${subresource}:${level} permission`,
    { metadata_subresource: subresource, required: level },
  );
}

/**
 * Authority over one administrative surface, asked of the credential's own
 * permission set. A key carries its permissions on its row and a
 * sign-in carries them on its grant; nothing here reads what kind of
 * credential arrived, and nothing admits a caller that was never handed the
 * permission.
 *
 * **A bootstrap caller is refused here, and its protection is the route's
 * rather than this function's.** Bootstrap presents no credential at all:
 * `apiKey` is undefined and `authType` unset, so `checkAuth` throws before the
 * OAuth question is reached. That is the right answer for a helper that cannot
 * see the sentinel, and it means a call site on the mint path has to sit
 * inside its own `if (!isBootstrap)` block, where every other authority check
 * on that route already is. Do not weaken this to admit the shape; put the
 * call in the right place.
 *
 * **This is the whole of the check on the surface, not a second half.**
 * Nothing admits a caller to an administrative door on what kind of
 * credential it is, so a door that should ask this and does not stands open
 * to any authenticated caller. No scan can find one either, because
 * `requireAuth` sits on nearly every handler and leaves no signature to key
 * on; `routes/permission-door-census.test.ts` holds the doors that do
 * ask to asking for the right surface.
 *
 * **A missing carrier fails closed.** An OAuth request that reached a gate
 * with no `oauthGrant` set is a defect in the bearer middleware, and the safe
 * reading of "I cannot tell what was granted" is "nothing was".
 *
 * The refusal names the literal that would satisfy it, in the message and in
 * `details`. A generic 403 on an administrative surface leaves the reader
 * nothing to act on, and a client cannot narrow toward a scope nobody told it
 * about.
 */
export function requirePermission(
  c: Context<AppEnv>,
  permission: Permission,
): void {
  const key = checkAuth(c.get("apiKey"));
  // **One question, asked of one list, whichever kind of credential arrived.**
  // A key carries its permissions on its row and a sign-in carries them
  // on its grant, and both are the literals themselves — so the door does not
  // branch on what it is looking at, and there is no second implementation to
  // drift.
  const held =
    c.get("authType") === "oauth"
      ? (c.get("oauthGrant")?.scopes ?? [])
      : (key.permissions ?? []);
  if (hasPermission(held, permission)) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `This credential does not hold ${permission}`,
    { required_scope: permission },
  );
}

/**
 * The filter a data-plane read narrows by, refusing a credential the map
 * leaves nowhere to look.
 *
 * An empty `allowed` at read level is a credential that may read no type
 * at all. Answering it `200` with an empty page says "there is nothing
 * here", which is not what happened: there is a great deal here and this
 * credential may not see it. The single-row doors say so, since
 * `checkTypeAccess` resolves the same empty map to `none` and throws
 * `type_not_permitted`, and refusing here too answers one question one way
 * however many rows the caller asked for.
 *
 * **Only at read level.** `POST /items/bulk-actions` asks at `"write"`,
 * where it narrows a match set rather than refusing a row, and a key
 * holding read across the board matching nothing there is its own settled
 * behavior.
 *
 * **In the wrapper and not in `computeTypeFilter`**, which stays a pure
 * predicate: `refuseNarrowCredential` in `routes/webhooks.ts` asks it
 * whether a credential reaches everything and answers its own
 * `scoped_credential_not_permitted`, and a throw from the shared function
 * would change that door's refusal for the credentials it exists to catch.
 */
export function getTypeFilter(
  c: Context<AppEnv>,
  level: "read" | "write" = "read",
): TypeFilter {
  const filter = computeTypeFilter(c.get("apiKey"), level);
  // `allowed === undefined` is "no credential at all" and nothing else;
  // the doors that reach here have already required one.
  if (level === "read" && filter.allowed?.length === 0) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "This credential's type permissions reach no type, so there is nothing on the data plane it may read.",
    );
  }
  return filter;
}
