import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { hashApiKey, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/**
 * User auth routes — only mounted when AUTH_MODE=hosted.
 *
 * POST /auth/signup  — create user + tenant + admin API key
 * POST /auth/session — exchange provider identity for an existing API key
 * GET  /auth/me      — return current user profile + tenant info
 */
export function userAuthRoutes(
  storage: Storage,
  salt: string,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  if (!storage.users || !storage.tenants) {
    throw new Error("User and tenant stores required for hosted mode");
  }

  const userStore = storage.users;
  const tenantStore = storage.tenants;

  // POST /auth/signup — create user + tenant + admin API key
  router.post("/signup", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;

    const email = body.email as string | undefined;
    const name = body.name as string | undefined;
    const avatarUrl = body.avatar_url as string | undefined;
    const provider = body.provider as string | undefined;
    const providerId = body.provider_account_id as string | undefined;

    if (!email || !provider || !providerId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "email, provider, and provider_account_id are required",
      );
    }

    // Check if user already exists
    const existing = await userStore.getByProvider(provider, providerId);
    if (existing) {
      throw new MymeError(
        ErrorCode.CONFLICT,
        "User already exists for this provider",
      );
    }

    // Create tenant
    const tenant = await tenantStore.create(name ?? email);

    // Create user
    const user = await userStore.create({
      email,
      name,
      avatar_url: avatarUrl,
      provider,
      provider_id: providerId,
      tenant_id: tenant.id,
    });

    // Create admin API key for the tenant
    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);
    await storage.keys.create(
      {
        label: "admin",
        role: "admin",
        type_permissions: { "*": "write" },
      },
      keyHash,
      tenant.id,
    );

    return c.json({ user, tenant, api_key: rawKey }, 201);
  });

  // POST /auth/session — exchange provider identity for an existing API key
  router.post("/session", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;

    const provider = body.provider as string | undefined;
    const providerId = body.provider_account_id as string | undefined;

    if (!provider || !providerId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "provider and provider_account_id are required",
      );
    }

    const user = await userStore.getByProvider(provider, providerId);
    if (!user) {
      throw new MymeError(ErrorCode.NOT_FOUND, "User not found");
    }

    // Find an active admin API key for this tenant
    const allKeys = await storage.keys.list();
    // keys.list() returns all non-revoked keys. We need the one for this tenant.
    // Since list() doesn't filter by tenant, we filter client-side.
    // This is a hosted-only path, so the key set is small.
    const tenantKey = allKeys.find(
      (k) =>
        (k as { tenant_id?: string }).tenant_id === user.tenant_id &&
        k.role === "admin",
    );

    if (!tenantKey) {
      // Create a new admin key if none exists
      const rawKey = generateRawKey();
      const keyHash = hashApiKey(rawKey, salt);
      await storage.keys.create(
        {
          label: "admin",
          role: "admin",
          type_permissions: { "*": "write" },
        },
        keyHash,
        user.tenant_id,
      );
      return c.json({ user, api_key: rawKey });
    }

    // Revoke previous session keys to prevent unbounded key accumulation
    const previousSessionKeys = allKeys.filter(
      (k) =>
        (k as { tenant_id?: string }).tenant_id === user.tenant_id &&
        k.label === "session",
    );
    for (const prev of previousSessionKeys) {
      await storage.keys.revoke(prev.id);
    }

    // Create a fresh session key (we can't retrieve the raw key from the hash)
    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);
    await storage.keys.create(
      {
        label: "session",
        role: "admin",
        type_permissions: { "*": "write" },
      },
      keyHash,
      user.tenant_id,
    );
    return c.json({ user, api_key: rawKey });
  });

  // GET /auth/me — return current user profile + tenant info
  router.get("/me", async (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;

    if (!tenantId) {
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        "No tenant associated with this key",
      );
    }

    const [tenant, user] = await Promise.all([
      tenantStore.get(tenantId),
      userStore.getByTenantId(tenantId),
    ]);

    if (!tenant) {
      throw new MymeError(ErrorCode.NOT_FOUND, "Tenant not found");
    }

    return c.json({ user, tenant });
  });

  return router;
}
