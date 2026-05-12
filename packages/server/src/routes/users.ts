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
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const UserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_blob_hash: z.string().nullable(),
  provider: z.string(),
  provider_id: z.string(),
  tenant_id: z.string(),
  handle: z.string().nullable(),
  auth_user_id: z.string().nullable(),
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
  summary: "Sign up a user and create a tenant",
  description:
    "Creates a user, a tenant owned by that user, and a tenant-admin API key — all atomically. The user is identified by the `(provider, provider_account_id)` pair, typically sourced from an upstream identity provider (Google, GitHub, etc.). If a user already exists for that pair, returns `409 conflict` — use `POST /auth/session` to retrieve a fresh session key instead.\n\nLegacy provider-identity surface; the Better Auth flow at `/auth/sign-up/email` is the recommended sign-up path. Requires `AUTH_MODE=hosted`. See [Hosted mode](/self-hosting/hosted-mode).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // `email` taken for display-name fallback only; not stored on
            // `users` post-T-074. Modern Better-Auth signup is the
            // recommended path; this legacy provider-identity surface
            // exists for back-compat with pre-Better-Auth callers.
            email: z.email("email is required"),
            name: z.string().optional(),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "User already exists",
    },
  },
});

const sessionRoute = createRoute({
  method: "post",
  path: "/session",
  tags: ["Auth"],
  summary: "Exchange a provider identity for an API key",
  description:
    "Looks up an existing user by `(provider, provider_account_id)` and returns a session API key. Used by hosted-mode clients re-establishing access for a previously-signed-up user. If no user matches, returns `404 not_found`.\n\nLegacy provider-identity surface; the Better Auth sign-in flow is the recommended path. Requires `AUTH_MODE=hosted`.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "User not found",
    },
  },
});

const setHandleRoute = createRoute({
  method: "put",
  path: "/me/handle",
  tags: ["Auth"],
  summary: "Update the current user's handle",
  description:
    "Claims or changes the handle on the authenticated user. The handle is the user's public identifier — the same string that namespaces published types as `<handle>.<type>`. Lowercase alphanumeric and hyphens, 3–32 characters, no leading/trailing hyphens, no consecutive hyphens.\n\nReserved roots (`core`, `system`, `app`, `user`, `myme`) and a list of structural words (`admin`, `api`, etc.) are rejected with `400 handle_reserved`. Case-insensitive collision with another user returns `409 conflict`. See [Handles and publishers](/concepts/handles-and-publishers).",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "handle_reserved",
          ]),
        },
      },
      description: "Invalid handle format",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "Handle already claimed by another user",
    },
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Get the current user",
  description:
    "Returns the user record and the tenant the calling API key belongs to. Use to render account state (handle, name, tenant id) once a session is established. For the richer profile shape (avatar, bio), use `GET /profile/me`. See [Profile](/concepts/profile).",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
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

  // POST /auth/signup — create user + tenant + admin API key.
  // T-074: legacy provider-identity signup. `email` is taken as input but
  // not stored on the `users` row (column dropped); used only as a tenant-
  // name fallback. `avatar_url` likewise dropped from input — modern
  // avatars go through the blob layer via /profile/me/avatar.
  router.openapi(signupRoute, async (c) => {
    const {
      email,
      name,
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

    // Create tenant — `email` only used as a display-name fallback.
    const tenant = await tenantStore.create(name ?? email);

    // Create user. No auth_user_id (Better Auth is the modern signup path).
    const user = await userStore.create({
      name,
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
