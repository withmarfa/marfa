import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const KeyResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.enum(["admin", "member"]),
  default_origin: z.enum(["user", "ai", "worker"]),
  default_library: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const KeyListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.string(),
  default_origin: z.enum(["user", "ai", "worker"]),
  default_library: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createKeyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Keys"],
  summary: "Create a new API key",
  description:
    "Creates a new API key. In bootstrap mode (zero keys exist), no auth is required and the key is always admin.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().min(1, "label is required"),
            source: z
              .string()
              .min(1, "source display name is required")
              .max(200),
            role: z.enum(["admin", "member"]).optional(),
            default_origin: z.enum(["user", "ai", "worker"]).optional(),
            default_library: z.boolean().optional(),
            type_permissions: z
              .record(z.string(), z.enum(["read", "write", "none"]))
              .optional(),
            extension_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: KeyResponseSchema,
        },
      },
      description: "API key created",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Keys"],
  summary: "List all API keys",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            keys: z.array(KeyListItemSchema),
          }),
        },
      },
      description: "List of API keys",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const revokeKeyRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Revoke an API key",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Key revoked",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function keyRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createKeyRoute, async (c) => {
    const isBootstrap = c.get("isBootstrap");
    if (!isBootstrap) {
      requireAdmin(c);
    }

    const body = c.req.valid("json");

    const role = isBootstrap ? "admin" : (body.role ?? "member");

    const typePermissions = body.type_permissions ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: role,
        default_origin: body.default_origin,
        default_library: body.default_library,
        type_permissions: typePermissions,
        extension_permissions: body.extension_permissions,
      },
      keyHash,
    );

    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "key.create",
      resource_type: "key",
      resource_id: stored.id,
    });

    return c.json(
      {
        id: stored.id,
        key: rawKey,
        label: stored.label,
        source: stored.source,
        role: stored.role,
        default_origin: stored.default_origin,
        default_library: stored.default_library,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    requireAdmin(c);
    return c.json({ keys: await storage.keys.list() }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    await storage.keys.revoke(id);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "key.revoke",
      resource_type: "key",
      resource_id: id,
    });

    return c.json({ ok: true as const }, 200);
  });

  return router;
}
