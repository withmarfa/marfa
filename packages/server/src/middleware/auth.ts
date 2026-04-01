import { createHmac } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { ProtocolError, ErrorCode, resolveTypePermission, scopesToTypePermissions } from "@myme/shared";
import type { ApiKey } from "@myme/shared";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Hono environment type (shared across all routes)
// ---------------------------------------------------------------------------

export interface AppEnv {
  Variables: {
    apiKey: ApiKey | undefined;
    isBootstrap: boolean;
    authType: "api_key" | "oauth" | undefined;
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
    // Bootstrap detection: POST /keys with no existing keys
    if (c.req.method === "POST" && c.req.path === "/keys") {
      const keyCount = await storage.keys.count();
      if (keyCount === 0) {
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

      // Build a synthetic ApiKey from the OAuth token's scopes
      const typePermissions = scopesToTypePermissions(oauthToken.scopes);
      c.set("apiKey", {
        id: oauthToken.id,
        label: `oauth:${oauthToken.grant_id}`,
        role: "member",
        type_permissions: typePermissions,
        created_at: oauthToken.created_at,
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
        role: stored.role,
        type_permissions: stored.type_permissions,
        created_at: stored.created_at,
      });
      c.set("authType", "api_key");

      // Debounced last_used_at update
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
// Context-agnostic access control (used by both REST and GraphQL)
// ---------------------------------------------------------------------------

export function checkAuth(apiKey: ApiKey | undefined): ApiKey {
  if (!apiKey) {
    throw new ProtocolError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }
  return apiKey;
}

export function checkAdmin(apiKey: ApiKey | undefined): ApiKey {
  const key = checkAuth(apiKey);
  if (key.role !== "admin") {
    throw new ProtocolError(ErrorCode.FORBIDDEN, "Admin access required");
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
    throw new ProtocolError(ErrorCode.TYPE_NOT_PERMITTED, `No access to type "${type}"`);
  }
  if (level === "write" && resolved === "read") {
    throw new ProtocolError(
      ErrorCode.TYPE_NOT_PERMITTED,
      `Write access to type "${type}" denied`,
    );
  }
}

export function computeTypeFilter(apiKey: ApiKey | undefined): string[] | undefined {
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

export function getTypeFilter(c: Context<AppEnv>): string[] | undefined {
  return computeTypeFilter(c.get("apiKey"));
}
