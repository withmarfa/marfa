import { createHmac } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import {
  MymeError,
  ErrorCode,
  resolveTypePermission,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  edgePermissionCovers,
  metadataPermissionCovers,
} from "@mymehq/shared";
import type { ApiKey } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Hono environment type (shared across all routes)
// ---------------------------------------------------------------------------

// Note: `extends Record<string, unknown>` — @hono/zod-openapi's router
// generic requires this constraint. Pure interfaces don't satisfy it under
// strict TypeScript (interfaces are open to external augmentation), so we
// pull in the index signature explicitly.
export interface AppEnv extends Record<string, unknown> {
  Variables: {
    apiKey: ApiKey | undefined;
    isBootstrap: boolean;
    authType: "api_key" | "oauth" | undefined;
    requestId: string;
  };
}

// ---------------------------------------------------------------------------
// Key hashing
// ---------------------------------------------------------------------------

const KEY_PREFIX = "myme_k1_";
const ACCESS_TOKEN_PREFIX = "myme_at_";
const DEBOUNCE_MS = 3600_000; // 1 hour

export function hashApiKey(raw: string, salt: string): string {
  return createHmac("sha256", salt).update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export function authMiddleware(storage: Storage, salt: string) {
  const lastUsedCache = new Map<string, number>();

  return createMiddleware<AppEnv>(async (c, next) => {
    // Bootstrap detection: POST /keys on a workspace that has never
    // had a key. The gate is a persistent `settings.bootstrapped`
    // sentinel, NOT a live `keys.count() === 0` check — revoking every
    // key must not re-open bootstrap (would let an unauthenticated
    // caller mint an admin key and take over the workspace).
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

    // OAuth access token
    if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      const hash = hashApiKey(token, salt);
      const oauthToken = await storage.oauth.validateToken(hash);

      if (!oauthToken) {
        c.set("apiKey", undefined);
        c.set("authType", undefined);
        return next();
      }

      // Build a synthetic ApiKey from the OAuth token's scopes.
      // Credential-default fields (source, default_origin, default_tier)
      // are synthesised here; full parity with stored API keys remains
      // outstanding.
      const typePermissions = scopesToTypePermissions(oauthToken.scopes);
      const edgePermissions = scopesToEdgePermissions(oauthToken.scopes);
      const metadataPermissions = scopesToMetadataPermissions(
        oauthToken.scopes,
      );
      c.set("apiKey", {
        id: oauthToken.id,
        label: `oauth:${oauthToken.connection_item_id}`,
        source: `oauth:${oauthToken.connection_item_id}`,
        role: "member",
        default_origin: "user",
        default_tier: "library",
        is_platform: false,
        type_permissions: typePermissions,
        extension_permissions: {},
        edge_permissions: edgePermissions,
        metadata_permissions: metadataPermissions,
        created_at: oauthToken.created_at,
        last_used_at: null,
      });
      c.set("authType", "oauth");
      return next();
    }

    // API key
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
        default_origin: stored.default_origin,
        default_tier: stored.default_tier,
        is_platform: stored.is_platform,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      });
      c.set("authType", "api_key");

      // Debounced last_used_at update. The DB layer (KeyStore.updateLastUsed)
      // now enforces the real floor via a conditional UPDATE, so this in-memory
      // cache is a per-instance round-trip skip rather than the source of
      // truth — multiple instances can't write more often than once per
      // DEBOUNCE_MS per key regardless of what's in any given instance's cache.
      const now = Date.now();
      const lastTracked = lastUsedCache.get(stored.id) ?? 0;
      if (now - lastTracked > DEBOUNCE_MS) {
        lastUsedCache.set(stored.id, now);
        await storage.keys.updateLastUsed(stored.id);
      }

      return next();
    }

    // Unknown token format
    c.set("apiKey", undefined);
    c.set("authType", undefined);
    return next();
  });
}

// ---------------------------------------------------------------------------
// Context-agnostic access control
// ---------------------------------------------------------------------------

export function checkAuth(apiKey: ApiKey | undefined): ApiKey {
  if (!apiKey) {
    throw new MymeError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }
  return apiKey;
}

export function checkAdmin(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (key.role !== "admin") {
    throw new MymeError(ErrorCode.FORBIDDEN, "Admin access required");
  }
  return key;
}

export function checkTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  const key = checkAuth(apiKey);
  if (key.role === "admin") return;

  const resolved = resolveTypePermission(type, key.type_permissions);
  if (resolved === "none") {
    throw new MymeError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `No access to type "${type}"`,
    );
  }
  if (level === "write" && resolved === "read") {
    throw new MymeError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Write access to type "${type}" denied`,
    );
  }
}

export function computeTypeFilter(
  apiKey: ApiKey | undefined,
): string[] | undefined {
  if (!apiKey || apiKey.role === "admin") return undefined;

  const patterns: string[] = [];
  for (const [pattern, permission] of Object.entries(apiKey.type_permissions)) {
    if (permission === "read" || permission === "write") {
      patterns.push(pattern);
    }
  }
  // Empty array (no readable types) means "no items" — not "all items"
  return patterns;
}

// ---------------------------------------------------------------------------
// Hono-specific wrappers (delegate to context-agnostic functions)
// ---------------------------------------------------------------------------

export function requireAuth(c: Context<AppEnv>): ApiKey {
  return checkAuth(c.get("apiKey"));
}

export function requireAdmin(c: Context<AppEnv>): ApiKey {
  return checkAdmin(c.get("apiKey"));
}

export function requireTypeAccess(
  c: Context<AppEnv>,
  type: string,
  level: "read" | "write",
): void {
  checkTypeAccess(c.get("apiKey"), type, level);
}

/**
 * Enforces a per-edge-type permission check. Admin keys always pass.
 * Non-admin keys need either the specific edge-type permission or the
 * `*` wildcard at the requested level (write covers read). Reads fall
 * back through edgePermissionCovers which also accepts wildcard.
 *
 * Throws EDGE_PERMISSION_DENIED (403) on failure — the discriminator
 * code lets SDK clients route `forbidden` differently from specifically
 * an edge-permission failure.
 */
export function requireEdgePermission(
  c: Context<AppEnv>,
  edgeType: string,
  level: "read" | "write",
): void {
  const apiKey = checkAuth(c.get("apiKey"));
  if (apiKey.role === "admin") return;
  if (edgePermissionCovers(apiKey.edge_permissions, edgeType, level)) return;
  throw new MymeError(
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
  if (apiKey.role === "admin") return;
  if (metadataPermissionCovers(apiKey.metadata_permissions, subresource, level))
    return;
  throw new MymeError(
    ErrorCode.FORBIDDEN,
    `Missing metadata.${subresource}:${level} permission`,
    { metadata_subresource: subresource, required: level },
  );
}

export function getTypeFilter(c: Context<AppEnv>): string[] | undefined {
  return computeTypeFilter(c.get("apiKey"));
}
