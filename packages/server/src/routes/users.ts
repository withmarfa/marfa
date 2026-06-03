import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidHandle,
  isReservedHandle,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

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

const setHandleRoute = createRoute({
  method: "put",
  path: "/me/handle",
  tags: ["Auth"],
  summary: "Update the current user's handle",
  description:
    "Claims or changes the handle on the authenticated user. The handle is the user's public identifier — the same string that namespaces published types as `<handle>.<type>`. Lowercase alphanumeric and hyphens, 3–32 characters, no leading/trailing hyphens, no consecutive hyphens.\n\nReserved roots (`core`, `system`, `app`, `user`, `marfa`) and a list of structural words (`admin`, `api`, etc.) are rejected with `400 handle_reserved`. Case-insensitive collision with another user returns `409 conflict`. See [Handles and publishers](/concepts/handles-and-publishers).",
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
 * GET  /auth/me          — return current user profile + tenant info
 * PUT  /auth/me/handle   — claim or change the user's handle
 *
 * Sign-up + sign-in flow through the Better Auth surface mounted under
 * /auth/sign-up/email, /auth/sign-in/email, etc. (see auth-pages.ts).
 * Better Auth is the only sign-up path.
 */
export function userAuthRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  if (!storage.users || !storage.tenants) {
    throw new Error("User and tenant stores required for hosted mode");
  }

  const userStore = storage.users;
  const tenantStore = storage.tenants;

  // GET /auth/me — return current user profile + tenant info
  router.openapi(meRoute, async (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;

    if (!tenantId) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        "No tenant associated with this key",
      );
    }

    const [tenant, user] = await Promise.all([
      tenantStore.get(tenantId),
      userStore.getByTenantId(tenantId),
    ]);

    if (!tenant) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant not found");
    }

    return c.json({ user, tenant }, 200);
  });

  // PUT /auth/me/handle — claim or change handle
  router.openapi(setHandleRoute, async (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;
    if (!tenantId) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        "No tenant associated with this key",
      );
    }
    const user = await userStore.getByTenantId(tenantId);
    if (!user) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "User not found");
    }
    const { handle: rawHandle } = c.req.valid("json");
    const handle = rawHandle.toLowerCase();
    if (isReservedHandle(handle)) {
      throw new MarfaError(
        ErrorCode.HANDLE_RESERVED,
        `Handle "${handle}" is reserved`,
        { handle: rawHandle },
      );
    }
    if (!isValidHandle(handle)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid handle: lowercase alphanumeric + hyphens, 3-32 chars",
        { handle: rawHandle },
      );
    }
    const collision = await userStore.getByHandle(handle);
    if (collision && collision.id !== user.id) {
      throw new MarfaError(
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
