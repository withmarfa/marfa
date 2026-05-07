import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  isValidHandle,
  isReservedHandle,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { hashApiKey, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  provider: z.string(),
  provider_id: z.string(),
  tenant_id: z.string(),
  handle: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const TenantSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const signupRoute = createRoute({
  method: "post",
  path: "/signup",
  tags: ["Auth"],
  summary: "Create user, tenant, and admin API key",
  description:
    "Sign up a new user with a provider identity. Creates a tenant and an admin API key.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.email("email is required"),
            name: z.string().optional(),
            avatar_url: z.string().optional(),
            provider: z.string().min(1, "provider is required"),
            provider_account_id: z
              .string()
              .min(1, "provider_account_id is required"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            user: UserSchema,
            tenant: TenantSchema,
            api_key: z.string(),
          }),
        },
      },
      description: "User, tenant, and API key created",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "User already exists",
    },
  },
});

const sessionRoute = createRoute({
  method: "post",
  path: "/session",
  tags: ["Auth"],
  summary: "Exchange provider identity for an API key",
  description:
    "Look up an existing user by provider identity and return a session API key.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1, "provider is required"),
            provider_account_id: z
              .string()
              .min(1, "provider_account_id is required"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            user: UserSchema,
            api_key: z.string(),
          }),
        },
      },
      description: "Session API key returned",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "User not found",
    },
  },
});

const setHandleRoute = createRoute({
  method: "put",
  path: "/me/handle",
  tags: ["Auth"],
  summary: "Claim or change the current user's handle",
  description:
    "Sets the handle on the authenticated user (TSC42 §8). Lowercase alphanumeric and hyphens, 3–32 chars; reserved roots and structural words rejected. Returns 409 on case-insensitive collision with another user.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ handle: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ user: UserSchema }) },
      },
      description: "Handle claimed",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid handle format",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Handle already claimed by another user",
    },
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Get current user profile",
  description:
    "Return the current user profile and tenant info for the authenticated key.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            user: UserSchema.nullable(),
            tenant: TenantSchema,
          }),
        },
      },
      description: "User profile and tenant info",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Tenant not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * User auth routes — only mounted when AUTH_MODE=hosted.
 *
 * POST /auth/signup  — create user + tenant + admin API key
 * POST /auth/session — exchange provider identity for an existing API key
 * GET  /auth/me      — return current user profile + tenant info
 */
export function userAuthRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  if (!storage.users || !storage.tenants) {
    throw new Error("User and tenant stores required for hosted mode");
  }

  const userStore = storage.users;
  const tenantStore = storage.tenants;

  // POST /auth/signup — create user + tenant + admin API key
  router.openapi(signupRoute, async (c) => {
    const {
      email,
      name,
      avatar_url: avatarUrl,
      provider,
      provider_account_id: providerId,
    } = c.req.valid("json");

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
        source: "admin",
        role: "admin",
        type_permissions: { "*": "write" },
      },
      keyHash,
      tenant.id,
    );

    return c.json({ user, tenant, api_key: rawKey }, 201);
  });

  // POST /auth/session — exchange provider identity for an existing API key
  router.openapi(sessionRoute, async (c) => {
    const { provider, provider_account_id: providerId } = c.req.valid("json");

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
          source: "admin",
          role: "admin",
          type_permissions: { "*": "write" },
        },
        keyHash,
        user.tenant_id,
      );
      return c.json({ user, api_key: rawKey }, 200);
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
        source: "session",
        role: "admin",
        type_permissions: { "*": "write" },
      },
      keyHash,
      user.tenant_id,
    );
    return c.json({ user, api_key: rawKey }, 200);
  });

  // GET /auth/me — return current user profile + tenant info
  router.openapi(meRoute, async (c) => {
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

    return c.json({ user, tenant }, 200);
  });

  // PUT /auth/me/handle — claim or change handle
  router.openapi(setHandleRoute, async (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;
    if (!tenantId) {
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        "No tenant associated with this key",
      );
    }
    const user = await userStore.getByTenantId(tenantId);
    if (!user) {
      throw new MymeError(ErrorCode.NOT_FOUND, "User not found");
    }
    const { handle: rawHandle } = c.req.valid("json");
    const handle = rawHandle.toLowerCase();
    if (isReservedHandle(handle)) {
      throw new MymeError(
        ErrorCode.HANDLE_RESERVED,
        `Handle "${handle}" is reserved`,
        { handle: rawHandle },
      );
    }
    if (!isValidHandle(handle)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid handle: lowercase alphanumeric + hyphens, 3-32 chars",
        { handle: rawHandle },
      );
    }
    const collision = await userStore.getByHandle(handle);
    if (collision && collision.id !== user.id) {
      throw new MymeError(
        ErrorCode.CONFLICT,
        `Handle "${handle}" is already claimed`,
        { handle },
      );
    }
    const updated = await userStore.setHandle(user.id, handle);
    return c.json({ user: updated }, 200);
  });

  return router;
}
