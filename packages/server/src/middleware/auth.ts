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
  profilePermissionCovers,
  hasSpacePermission,
} from "@withmarfa/shared";
import type { ApiKey, SpacePermission, TypeFilter } from "@withmarfa/shared";
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
     * three projections beside them translate a token's scopes into
     * `type_permissions`, `edge_permissions` and `metadata_permissions`
     * and drop every literal they do not recognize — deliberately, since a
     * capability names authority over an administrative surface rather
     * than over a resource, and admitting one into a projection would put
     * it on the data plane where a wildcard could reach it. So the granted
     * set has to travel beside the projections rather than through them,
     * and `requireSpacePermission` is the only thing that reads it.
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
    /**
     * Cycle metadata for events published from this request. Resolved
     * by `cycleMiddleware` after auth from either the inbound
     * `X-Marfa-Cycle-Origin` / `X-Marfa-Cycle-Hop` headers (an integration
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
     * sentinel); an integration chain head is `{ originatingConnectionId:
     * <connection_id>, hopCount: 0 }`; an integration continuing a chain
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
 * Narrow a validated credential row to the shape routes see on
 * `c.var.apiKey`.
 *
 * `KeyStore.validate` returns `ApiKey` plus the two fields only the
 * store needs — `key_hash`, which no route may ever see, and
 * `revoked_at`, which is already spent by the time validation returns.
 *
 * Subtractive on purpose. Rebuilding the object field by field, which is
 * what this replaced, means every field added to `ApiKey` afterwards is
 * dropped until someone remembers to extend the list, and dropped
 * silently: the types agree either way because the missing fields are
 * optional. `item_source` was carried on the credential row and lost
 * exactly here, so item provenance kept rotating with the credential
 * while every layer that could have noticed was looking elsewhere.
 * Naming what to remove fails closed on the next field; naming what to
 * keep fails open.
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
 * Space-scoped via `spaceId` so a hosted-mode caller cannot trip
 * this against another space's grant row.
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
  spaceId: string | undefined,
): Promise<void> {
  const cacheKey = `oauth:${connectionItemId}`;
  const now = Date.now();
  const lastTracked = oauthLastUsedCache.get(cacheKey) ?? 0;
  if (now - lastTracked <= DEBOUNCE_MS) return;
  touchLastUsedCache(oauthLastUsedCache, cacheKey, now);
  try {
    await storage.oauth.updateLastUsedAt(
      connectionItemId,
      spaceId ?? null,
      DEBOUNCE_MS,
    );
  } catch {
    // Best-effort; the cache mark above prevents a stampede.
  }
}

/**
 * Stamp `last_used_at` keyed by (spaceId, clientId, authUserId)
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
    spaceId: string | undefined;
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
      spaceId: opts.spaceId ?? null,
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
    if (!itemId) return;
    await storage.oauth.updateLastUsedAt(
      itemId,
      opts.spaceId ?? null,
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

export function authMiddleware(
  storage: Storage,
  salt: string,
  authMode: "keys" | "hosted" = "keys",
) {
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
    // sub-ms, revocation stays clean). The row itself carries
    // `referenceId` (= space_id, populated by `clientReference` at
    // issuance), `userId`, `clientId`, and `scopes`. Everything the
    // synthetic ApiKey needs comes from the single row.
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
      // Space id from the plugin's referenceId column (= our clientReference
      // output, which returns the user's space_id at consent time).
      const oauthSpaceId = oauthToken.referenceId ?? undefined;
      // A NULL reference binds the token to no space, and in hosted mode
      // that is never a valid credential shape: the storage layer drops its
      // space predicate for a space-less caller, so honoring the token
      // would hand an accidental platform tier to whatever consent gap
      // produced it. Refuse like any other unresolvable bearer. Keys-mode
      // deployments are single-space and space-less by design, so they are
      // untouched.
      if (authMode === "hosted" && oauthSpaceId === undefined) {
        c.set("apiKey", undefined);
        c.set("authType", undefined);
        return next();
      }
      // Stable composite label/source. Used in audit rows; doesn't need
      // to be a real foreign-key handle — system.connection projection
      // is maintained separately.
      const grantHandle = `${oauthToken.clientId}:${oauthToken.userId ?? "anon"}`;
      const createdAtIso = oauthToken.createdAtMs
        ? new Date(oauthToken.createdAtMs).toISOString()
        : new Date().toISOString();
      // **No role is projected, because there is no role.** One account holds
      // one space and the first person in it holds everything, so a column
      // saying which of three kinds of person this is carried no information
      // that the permission set does not carry better. What the app may do is
      // the grant, which travels beside this principal rather than inside it.
      c.set("apiKey", {
        id: oauthToken.id,
        space_id: oauthSpaceId,
        label: `oauth:${grantHandle}`,
        source: `oauth:${grantHandle}`,
        default_tier: "library",
        // **An operator key is never derivable from a sign-in.** Running the
        // instance sits outside the permission model, so no consent screen can
        // offer it and no grant can reach it.
        is_operator: false,
        // The space permissions the door reads come from the grant beside this
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
      // Read only by `requireSpacePermission` and by the audit rows that name
      // the grant an action was taken through.
      c.set("oauthGrant", {
        scopes: oauthToken.scopes,
        clientId: oauthToken.clientId,
        authUserId: oauthToken.userId ?? null,
      });

      if (oauthToken.userId) {
        void stampOAuthGrantLastUsedByGrantKey(storage, {
          spaceId: oauthSpaceId,
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
 * Credential `source` prefixes a caller may not name for itself.
 *
 * A caller-supplied `source` is free text, and two separate readers give
 * one meaning, so the reservation covers both.
 *
 * `oauth:` is read as authority. `actsAsConnection` compares against it
 * on the three routes a Connection operates on itself, and the cycle
 * resolver derives an event's origin from it. Without the reservation
 * any caller that may mint a key could source one `oauth:<something>`
 * and be read later as a Connection it has no binding to. The comparison
 * is currently unsatisfiable for the reason given on `actsAsConnection`,
 * which makes this a fence around an identity that is meant to work rather
 * than one that does, and it has to hold before that is corrected rather
 * than after.
 *
 * `integration:` is read as provenance. No route reads it as identity:
 * `itemProvenanceSource` stamps it onto rows an integration writes, and
 * `permitsMirrorWrite` then admits only a credential whose `item_source`
 * matches. A forged one would let any credential claim to be the owning
 * integration of a mirrored row and write over a corpus it does not own.
 *
 * Either way the shape is the same: a field the request controls, read
 * later as something it earned.
 *
 * The legitimate holders never pass through the mint routes. Runtime
 * credentials are created at the storage layer by the per-dispatch
 * mint; the OAuth shape is synthesized per-request in this file and
 * never persisted at all.
 */
export const RESERVED_CREDENTIAL_SOURCE_PREFIXES = [
  "oauth:",
  "integration:",
  "runtime-",
] as const;

/** Whether `source` claims one of the reserved integration shapes. */
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
 * Operator gate. Guards the surfaces whose authority is instance-wide
 * rather than space-bounded: space CRUD, cross-space quota writes,
 * instance metrics, the audit log, archive restore, blob reconciliation.
 *
 * Operator authority is authority that is NOT confined to a space, so the
 * gate tests two things: `is_operator` AND the absence of a space binding.
 * The flag alone is not sufficient, and `hasOperatorAuthority` below is
 * where that pair is asked and why.
 *
 * Consequence for callers: a key that passes this gate always has
 * `space_id === undefined`. A surface that belongs inside a space wants
 * `requireSpacePermission` instead, and must thread `key.space_id` into
 * every storage call it makes.
 */
export function checkOperatorKey(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (!hasOperatorAuthority(key)) {
    throw new MarfaError(ErrorCode.FORBIDDEN, "Operator key required");
  }
  return key;
}

/**
 * Predicate form of `checkOperatorKey`'s test, for the handful of routes that
 * need the answer as a boolean rather than a throw (they combine it with an
 * integration-credential branch, or use it to widen a space filter).
 *
 * **Running the instance is not a permission**, which is why this reads two
 * fields on the row rather than a member of the permission set. The operator
 * key is fenced outside the model deliberately: it is never offered on a
 * consent screen, never derivable from a sign-in, and never needed by an app.
 *
 * The space test is half the gate rather than a detail. `POST
 * /admin/spaces/{id}/keys` mints a credential "whose authority is confined to
 * id", and such a key carries no operator flag — but a hand-rolled
 * `is_operator` alone would readmit anything that ever gained one while bound
 * to a space, so the two fields are asked together, here, once.
 */
export function hasOperatorAuthority(key: ApiKey): boolean {
  return key.is_operator && !key.space_id;
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
 * Three ways through, and the third is narrower than it looks. A platform
 * credential passes outright. A runtime credential writing `system.activity`
 * passes, because that is the channel an integration reports its own
 * progress through and without it a legitimate one cannot emit anything —
 * whose rows it may touch is then decided per row by the attribution rule
 * rather than here. And a runtime credential writing a `marfa.*` type its
 * manifest declared passes, because that literal is the platform's own
 * declaration for that credential.
 *
 * **The map is read directly rather than resolved, and that is the whole
 * safety of the third arm.** `resolveTypePermission` honours wildcards, so
 * any credential holding `"*": "write"` would otherwise cross the reserved
 * boundary. Only an exact literal qualifies. `system.*` keeps the blanket
 * refusal beyond the activity carve-out: nothing projects a system-type
 * write.
 */
export function mayWriteReserved(key: ApiKey, type: string): boolean {
  if (key.is_operator) return true;
  const tier = classifyNamespace(type);
  if (tier !== "system" && tier !== "marfa") return true;
  if (key.is_runtime_credential !== true) return false;
  if (type === "system.activity") return true;
  return tier === "marfa" && key.type_permissions[type] === "write";
}

export function checkTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);

  // Operator gate. Writes to `system.*` (and the internal-only `marfa.*`)
  // require `is_operator: true`, which is the instance tier and nothing a
  // space-bound credential can hold. It is a fence rather than a route: the
  // operator key's own maps are empty, so in practice the platform's own
  // machinery writes these rows through the storage layer rather than through
  // a credential at all.
  //
  // `core.*` writes are NOT gated here — core types are user-facing
  // (core.note, core.task, core.bookmark) and ordinary credentials write them
  // routinely. Registering a new one is a different matter: `routes/types.ts`
  // refuses a reserved root to every credential, the operator key included,
  // because the shipped vocabulary is a property of the build.
  //
  // Reads to `system.*` / `marfa.*` are unrestricted (filtered by space
  // scoping at the storage layer); only writes need `is_operator`.
  //
  // Carve-out: runtime credentials (`is_runtime_credential: true`) may
  // write `system.activity`. That's the integration's status-reporting
  // channel — the activity sink in `runtime-sdk` calls `POST /items`
  // with `type: "system.activity"` to surface progress / errors for the
  // connection the credential is bound to. Without the carve-out a
  // legitimate integration can't emit activity rows.
  if (level === "write") {
    const tier = classifyNamespace(type);
    if (
      (tier === "system" || tier === "marfa") &&
      !mayWriteReserved(key, type)
    ) {
      throw new MarfaError(
        ErrorCode.TYPE_NOT_PERMITTED,
        `Reserved namespace: only platform credentials may write ${tier}.* items`,
      );
    }
  }

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

/**
 * What a credential may reach at a given level, as a list query can express it.
 *
 * **Returns a pair, and that is the point.** `allowed` alone cannot say what
 * a permission map says: a `"none"` entry subtracts, and a filter assembled
 * from the granted patterns has no way to state a subtraction. This used to
 * be approximated — the global wildcard was enumerated into the concrete ids
 * it stood for, minus the excluded ones — and the approximation leaked in
 * both directions. A subtree grant with an exclusion nested beneath it,
 * `{"user.*": "read", "user.secret": "none"}`, carried no global wildcard, so
 * it was passed through whole and listed the one type it exists to withhold.
 * And rows orphaned by `DELETE /types/{id}?force=true` — the registration
 * dropped, the items deliberately kept — could not appear in an enumeration
 * over the registry, so they vanished from every listing while the point
 * check still served them by id.
 *
 * Both are the same failure: a list filter and a point check that disagree.
 * `excluded_types` states the subtraction instead of approximating it, so
 * neither shape has anywhere to hide, and nothing depends on the registry
 * naming every type any more.
 *
 * **The pair rather than a second function beside this one is deliberate.** A
 * call site that took the permitted list without the exclusions would fail
 * open, which is the defect above reintroduced one layer up, and it would do
 * so silently — every suite that does not mint an exclusion-carrying key
 * would still pass. Returning one object makes it unrepresentable: a call
 * site cannot forget a field it has to destructure. (Eight consumers today,
 * seven through `getTypeFilter` and one direct, on the change stream.)
 *
 * `allowed: undefined` keeps meaning "no restriction" and `allowed: []` keeps
 * meaning "nothing visible", so the contract at every call site survives.
 */
export function computeTypeFilter(
  apiKey: ApiKey | undefined,
  /**
   * Which grants count as permitting a type.
   *
   * `"read"` is the default and the historical behaviour, and it is right for
   * a listing: a caller may see anything it may read or write. A door that
   * *writes* what it matched has to ask the narrower question, and the one
   * that did not was `POST /items/bulk-actions` — filter-in, no per-row
   * permission check, so a key granted read across the board arrived with
   * nothing narrowed and then wrote to everything it matched. Two comments in
   * that route already said the narrowing was to writable types, which is
   * what made it hard to see: the sentence was there and the code did
   * something else.
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

export function requireTypeAccess(
  c: Context<AppEnv>,
  type: string,
  level: "read" | "write",
): void {
  checkTypeAccess(c.get("apiKey"), type, level);
}

/**
 * True when the caller IS the Connection, for the three routes a
 * Connection operates on itself: the OAuth proxy, its inbound-webhook
 * subscriptions, and its leased tokens.
 *
 * The live arm is the runtime credential. One minted for a Connection
 * carries `is_runtime_credential: true` and a `connection_id` stamped
 * at mint time, and nothing outside `createRuntimeCredential` sets
 * either field, so a caller cannot name its way into the pair. It is
 * matched as a pair rather than by `source` because a runtime
 * credential has no fixed source to match: the per-dispatch mint
 * appends a random suffix, keeping the column unique among live
 * credentials. Matching a fixed string is what this function exists to
 * stop three routes doing separately. Two of them had already widened
 * to the pair and the third had not, so it refused every credential a
 * running integration can hold while reading as though it admitted one.
 *
 * The `oauth:` arm matches nothing today. It is kept rather than
 * deleted because the intent is live and only the comparison is wrong:
 * the synthetic key an OAuth access token produces is sourced
 * `oauth:<clientId>:<userId>`, a stable grant handle rather than a
 * Connection id, and a Connection id is a UUIDv7 carrying no colon, so
 * the two can never be equal. Such a caller reaches these routes only by
 * holding the space permission each one asks for, so a grant that was not
 * given it is refused before this arm is consulted at all.
 * Correcting it means resolving a grant to its Connection, which
 * changes who can reach three live routes and needs its own
 * verification rather than riding along here.
 *
 * It answers identity only. Whether that identity may reach the
 * Connection at all is the caller's space fence, which each route
 * applies alongside this.
 */
export function actsAsConnection(
  key: ApiKey | undefined,
  connectionId: string,
): boolean {
  if (!key) return false;
  return (
    key.source === `oauth:${connectionId}` ||
    (key.is_runtime_credential === true && key.connection_id === connectionId)
  );
}

/**
 * True when the caller is a runtime credential reading the one Connection
 * it is bound to.
 *
 * A handler resolves its own `properties.configuration` with a plain
 * `GET /items/:connection_id`, so it needs read access to a
 * `system.connection` row. Granting `system.connection: read` in
 * `type_permissions` would be space-wide — `type_permissions` keys on
 * type, with no per-item axis — handing every integration read access to
 * every other Connection's configuration in the space. This carve-out is
 * the per-item form: the credential's `connection_id` stamp must equal
 * the item being read, so an integration sees its own Connection and no
 * other. Mirrors the identity check the connection-proxy and extension
 * routes already apply.
 */
export function isOwnConnectionRead(
  key: ApiKey | undefined,
  item: { id: string; type: string },
): boolean {
  return (
    key?.is_runtime_credential === true &&
    item.type === "system.connection" &&
    key.connection_id === item.id
  );
}

/**
 * The `source` an item written by this credential is stamped with.
 *
 * For a human-minted key this is the credential's own `source`, which is
 * immutable for the credential's life and therefore a stable identity.
 * Runtime credentials break that assumption: they are minted per
 * dispatch, and their `source` carries a per-mint suffix because the
 * column is unique per space among live credentials. Stamping it would
 * make provenance a function of which bearer generation happened to be
 * live at the time.
 *
 * That is not cosmetic. Upsert identity is `(source, source_id)`:
 * `findBySourceId` scopes its lookup by the item's `source`, so a
 * integration re-syncing an upstream record after a credential refresh
 * looks for it under a source no row carries, finds nothing, and creates
 * a second item. Every rotation forks the integration's whole corpus, and
 * because both writes succeed the failure is silent.
 *
 * `item_source` is derived from the bound Connection and is fixed for
 * the Connection's lifetime, so it is the value a runtime credential
 * stamps. Falling back to `source` keeps every non-runtime credential on
 * exactly the behavior it had, and keeps runtime credentials minted
 * before the column existed working until they are reaped.
 */
export function itemProvenanceSource(
  key: ApiKey | undefined,
): string | undefined {
  return key?.item_source ?? key?.source;
}

/**
 * The connection to record as having written a row (D63), or null.
 *
 * **Gated on `is_runtime_credential`, not on the shape of `source`.** Only
 * `createRuntimeCredential` sets that flag; `keys.create` cannot. The string
 * is not safe to reason from — the console's self-serve mint writes the
 * caller's `label` straight into `source`, so a space owner could mint one
 * labelled `integration:acme/calendar` and `itemProvenanceSource` would hand
 * back the forged value. Reading the flag makes that unreachable rather than
 * merely unlikely, which is the same reasoning
 * `resolveOrphanScopeForOwnWrite` already gives for the same choice.
 *
 * Null for every human-minted credential, which is why the column stays
 * nullable: a row a person wrote has no owning connection, and that is a
 * fact rather than a gap.
 */
export function writerConnectionOf(key: ApiKey | undefined): string | null {
  if (key?.is_runtime_credential !== true) return null;
  return key.connection_id ?? null;
}

/**
 * Refuse a `system.activity` write that claims to be a Connection other
 * than the writing runtime credential's own.
 *
 * The `system.activity` carve-out in `checkTypeAccess` lets a runtime
 * credential write into the reserved `system.*` namespace without being
 * a platform credential, because status reporting is how an integration
 * says anything at all. That carve-out is about the type; it says
 * nothing about whose activity the row claims to be.
 * `properties.connection_id` is the field every operator surface groups,
 * filters and alerts on, and it arrives in the request body.
 *
 * Left unchecked, one integration can write `severity: action_required`
 * rows against a sibling Connection in the same space: a Repairs inbox
 * entry telling a user to re-authorize an integration that is working
 * fine, attributed to an integration that never ran. Nothing distinguishes
 * the row from a real one, because on the wire it is a real one.
 *
 * A runtime credential is bound to exactly one Connection, so the rule
 * is equality with that binding. Every other credential is unaffected:
 * writing `system.*` at all already requires a platform credential,
 * which is an operator acting deliberately rather than an integration
 * acting on its own.
 *
 * Called from each door that can write an item rather than folded into
 * `checkTypeAccess`, which sees a type but never a body. A door that
 * skips it is the whole gap, so every call site is pinned by tests that
 * go through the routes — see `routes/item-write-doors.test.ts`, which
 * asserts the doors agree rather than testing each of them separately.
 */
export function requireActivityAttribution(
  key: ApiKey | undefined,
  type: string,
  properties: unknown,
): void {
  if (permitsActivityAttribution(key, type, properties)) return;
  const claimed = claimedConnectionId(properties);
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    "A runtime credential may only write activity for its own connection",
    { connection_id: typeof claimed === "string" ? claimed : null },
  );
}

/**
 * The predicate behind `requireActivityAttribution`, for the one door
 * that narrows rather than refuses.
 *
 * `POST /items/bulk-actions` takes a filter, not a list of rows, and its
 * established answer to "the caller may not touch that" is to drop the
 * row from the match set (`getTypeFilter` already narrows the same set by
 * type). Throwing there would make one unreachable row fail an otherwise
 * legitimate action over thousands, which is a worse answer than the one
 * the route already gives for the type axis.
 */
/** The provenance prefix every integration-written row carries. */
export const INTEGRATION_SOURCE_PREFIX = "integration:";

/**
 * One rule: nothing writes to an item an integration owns. Ownership is
 * provenance — a row whose source carries the integration prefix is an
 * integration's mirror of an external record, and the owning integration
 * re-syncing (a credential whose item_source matches the row's source)
 * is the only legitimate writer of its properties. Everyone else,
 * operator keys included, is refused toward promotion: two write
 * paths onto one mirror is how user edits and re-syncs silently clobber
 * each other. Lifecycle transitions, tags, and extensions stay user
 * gestures — they do not edit the copy, so they do not answer to this.
 *
 * Called from each property-writing door, like the attribution check
 * beside it; the same door-coverage tests pin the set.
 */
export function requireMirrorProtection(
  key: ApiKey | undefined,
  row: { id: string; source: string },
): void {
  if (permitsMirrorWrite(key, row)) return;
  throw new MarfaError(
    ErrorCode.INTEGRATION_OWNED,
    "This item is an integration's copy of an external record; only the owning integration writes it. Promote it to edit your own copy",
    { item_id: row.id, source: row.source },
  );
}

/** The predicate behind `requireMirrorProtection`, for the door that
 *  narrows rather than refuses (`POST /items/bulk-actions`). */
export function permitsMirrorWrite(
  key: ApiKey | undefined,
  row: { id: string; source: string },
): boolean {
  if (!row.source.startsWith(INTEGRATION_SOURCE_PREFIX)) return true;
  return key?.item_source === row.source;
}

/**
 * The type a write declares is the type it lands on, or the write is
 * refused.
 *
 * Most doors address a row by something other than its type — a natural
 * key, or an id — and carry a `type` in the body that played no part in
 * finding it. Those doors took the resolved row's type and merged the
 * submitted properties onto it, so a caller that declared one type and
 * resolved another was not refused, it was reinterpreted, with a 200 and
 * nothing said.
 *
 * Two doors are exempt and neither by omission. `POST /items` create
 * resolves no row, so the type it names IS the row. `bulk-actions`
 * selects by filter, where a type is a selector and cannot disagree with
 * what it selected.
 *
 * Refusing here rather than in each caller is the deliberate half, and
 * the reason is stronger than it first looked. Counted against the
 * integrations repository rather than recalled: **no inbound integration
 * reads the type of the row it is about to write.** Every `getItem` call
 * in every handler fetches either the connection's own configuration row
 * or, on the outbound path, the item an event names.
 *
 * Eight address the row by an id they cached from an earlier sync, which
 * is what lets them call the update route at all. That is an identity
 * cache, not a type check: it narrows the exposure without closing it.
 * Five cannot even do that — three hold a bounded delivery ring rather
 * than item ids, and two hand a whole page to a bulk upsert with no
 * per-record id to read by.
 *
 * Deliberately no fleet total here. It depends on whether the scaffold
 * package and the one write-only integration are counted, an earlier
 * draft of this comment asserted one, and it was wrong.
 *
 * So there is no caller-side defence to defer to. The door is the only
 * place the disagreement can be seen at all, which is also why it does
 * not care why the two types differ — a type a caller derives fresh on
 * every run from configuration the user can change is the likeliest
 * source, and no caller is in a position to notice.
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
  // type unfalsifiable for every type with descendants, which is most of
  // them. The claim is either the row's type or it is not, and a caller
  // that means to move a corpus between types has an operation for it.
  if (declared === row.type) return;
  throw new MarfaError(
    ErrorCode.TYPE_MISMATCH,
    `Request declares type "${declared}" but resolves an item of type "${row.type}"; a write does not re-type the row it lands on`,
    { item_id: row.id, declared_type: declared, actual_type: row.type },
  );
}

export function permitsActivityAttribution(
  key: ApiKey | undefined,
  type: string,
  properties: unknown,
): boolean {
  if (key?.is_runtime_credential !== true) return true;
  if (type !== "system.activity") return true;
  // An absent `connection_id` is not a pass. The type requires the field,
  // so omitting it is either a malformed row or an attempt to write one
  // no attribution check can bind — and an unattributed activity row
  // still lands in the operator surface.
  return claimedConnectionId(properties) === key.connection_id;
}

function claimedConnectionId(properties: unknown): unknown {
  return properties && typeof properties === "object"
    ? (properties as Record<string, unknown>).connection_id
    : undefined;
}

/**
 * May this credential write to a row that already exists?
 *
 * The attribution helpers above answer a question about a *claim*: the
 * body says it is writing `system.activity` for connection X, and the
 * check is whether X is the caller's own. Every surface that reaches an
 * existing row by id asks a simpler question, because there is no claim
 * to weigh — the row states whose it is, and the caller either owns it or
 * does not.
 *
 * This is that check, and it is one function rather than a call at each
 * door on purpose. Five doors have now been found reaching state their
 * caller had no permission for, and four were found by a person asking
 * what else had the shape. Enumerating doors was never the reliable part,
 * so the lifecycle, metadata and extension surfaces share this rather
 * than each remembering a rule.
 *
 * Type permission is a separate axis and is still checked by the caller.
 * This narrows within a type the caller may already write, which is the
 * gap: `system.activity` sits in every runtime credential's type filter,
 * because that grant is what lets an integration report its own progress.
 */
export function requireRowWritable(
  key: ApiKey | undefined,
  row: { type: string; properties?: unknown } | undefined,
): void {
  if (!row) return;
  if (permitsActivityAttribution(key, row.type, row.properties)) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    "A runtime credential may only write rows belonging to its own connection",
    { type: row.type },
  );
}

/**
 * Enforces a per-edge-type permission check. Every credential needs either
 * the specific edge-type permission or the `*` wildcard at the requested
 * level (write covers read), and nothing passes without one.
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
 * error details so SDK clients can surface a precise re-auth prompt.
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
  // credential, operator included, and publisher namespaces bind to the
  // caller's claimed handle in hosted mode.
  if (metadataPermissionCovers(apiKey.metadata_permissions, subresource, level))
    return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Missing metadata.${subresource}:${level} permission`,
    { metadata_subresource: subresource, required: level },
  );
}

/**
 * Predicate form of {@link requireSpacePermission}, for the doors that combine
 * a permission with an arm of their own.
 *
 * The connection surfaces are the reason it exists: a caller reaches them
 * either by holding the space permission or by *being* the connection, as an
 * OAuth grant or as a runtime credential stamped with the connection id. That
 * is an `||`, not a gate, so it needs an answer rather than a throw.
 *
 * Exported so no call site re-derives it. The two forms read the same list
 * through the same helper, which is what keeps a predicate from drifting into
 * a second, laxer definition of the same question.
 */
export function holdsSpacePermission(
  c: Context<AppEnv>,
  permission: SpacePermission,
): boolean {
  const key = c.get("apiKey");
  if (!key) return false;
  const held =
    c.get("authType") === "oauth"
      ? (c.get("oauthGrant")?.scopes ?? [])
      : (key.space_permissions ?? []);
  return hasSpacePermission(held, permission);
}

/**
 * Authority over one administrative surface, asked of the credential's own
 * permission set. A key carries its space permissions on its row and a
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
 * on; `routes/space-permission-door-census.test.ts` holds the doors that do
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
export function requireSpacePermission(
  c: Context<AppEnv>,
  permission: SpacePermission,
): void {
  const key = checkAuth(c.get("apiKey"));
  // **One question, asked of one list, whichever kind of credential arrived.**
  // A key carries its space permissions on its row and a sign-in carries them
  // on its grant, and both are the literals themselves — so the door does not
  // branch on what it is looking at, and there is no second implementation to
  // drift.
  const held =
    c.get("authType") === "oauth"
      ? (c.get("oauthGrant")?.scopes ?? [])
      : (key.space_permissions ?? []);
  if (hasSpacePermission(held, permission)) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `This credential does not hold ${permission}`,
    { required_scope: permission },
  );
}

/**
 * Category 2 of the permission model, Your profile.
 *
 * Deliberately the same shape as {@link requireMetadataPermission}, because
 * the distinction that matters is not which endpoint a caller chose but what
 * it holds. A key carries `profile_permissions` on its row and a sign-in
 * carries `profile:<verb>` or `profile.<row>:<verb>` on its grant; both are
 * read through one map, and neither has anything to bypass it with.
 *
 * **The category is levelled, so `read` is a level rather than a baseline.** A
 * token holding nothing here may not read a name or an email address, which is
 * the difference between this and an item-type axis and the reason the design
 * calls it Category 2 rather than a field on Category 1.
 */
export function requireProfilePermission(
  c: Context<AppEnv>,
  row: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(c.get("apiKey"));
  if (profilePermissionCovers(apiKey.profile_permissions, row, level)) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Missing profile.${row}:${level} permission`,
    { profile_row: row, required: level },
  );
}

export function getTypeFilter(
  c: Context<AppEnv>,
  level: "read" | "write" = "read",
): TypeFilter {
  return computeTypeFilter(c.get("apiKey"), level);
}
