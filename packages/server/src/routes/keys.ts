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

const EdgePermissionsSchema = z
  .record(z.string(), z.enum(["read", "write"]))
  .optional();

const KeyResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.enum(["admin", "member"]),
  default_origin: z.enum(["user", "ai", "worker"]),
  default_tier: z.enum(["library", "feed"]),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const KeyListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.string(),
  default_origin: z.enum(["user", "ai", "worker"]),
  default_tier: z.enum(["library", "feed"]),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
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
            default_tier: z.enum(["library", "feed"]).optional(),
            type_permissions: z
              .record(z.string(), z.enum(["read", "write", "none"]))
              .optional(),
            extension_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
            edge_permissions: z
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

// Passthrough — immutable fields (source, role) are rejected explicitly in the
// handler with a readable error instead of a generic "unrecognized keys".
const UpdateKeyBodySchema = z.object({
  label: z.string().min(1).optional(),
  default_origin: z.enum(["user", "ai", "worker"]).optional(),
  default_tier: z.enum(["library", "feed"]).optional(),
  type_permissions: z
    .record(z.string(), z.enum(["read", "write", "none"]))
    .optional(),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  source: z.unknown().optional(),
  role: z.unknown().optional(),
});

const KeyDetailSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.enum(["admin", "member"]),
  default_origin: z.enum(["user", "ai", "worker"]),
  default_tier: z.enum(["library", "feed"]),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const updateKeyRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Update an API key in place",
  description:
    "Updates mutable fields on an API key. `source` and `role` are immutable after creation and rejected with 400 if present. Admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: UpdateKeyBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: KeyDetailSchema } },
      description: "Key updated",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid update (e.g. attempt to mutate an immutable field)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Admin only",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Key not found",
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
        default_tier: body.default_tier,
        type_permissions: typePermissions,
        extension_permissions: body.extension_permissions,
        edge_permissions: body.edge_permissions,
      },
      keyHash,
    );

    // On the first (bootstrap) key creation, stamp the workspace as
    // bootstrapped. From this point on, revoking every key must NOT
    // re-open bootstrap — the auth middleware reads this sentinel
    // instead of counting live keys.
    if (isBootstrap) {
      await storage.settings.set("bootstrapped", "true");
    }

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
        default_tier: stored.default_tier,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
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

  router.openapi(updateKeyRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    if ("source" in body) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "`source` is immutable after creation — it is baked into item provenance. Revoke and issue a new key instead.",
      );
    }
    if ("role" in body) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "`role` is immutable after creation for security reasons. Revoke and issue a new key instead.",
      );
    }

    const existing = await storage.keys.get(id);
    if (!existing) {
      throw new MymeError(ErrorCode.NOT_FOUND, `Key ${id} not found`);
    }

    const updated = await storage.keys.update(id, {
      label: body.label,
      default_origin: body.default_origin,
      default_tier: body.default_tier,
      type_permissions: body.type_permissions,
      extension_permissions: body.extension_permissions,
      edge_permissions: body.edge_permissions,
    });

    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "key.update",
      resource_type: "key",
      resource_id: id,
      details: {
        fields: Object.keys(body).filter((k) => k !== "source" && k !== "role"),
      },
    });

    return c.json(
      {
        id: updated.id,
        label: updated.label,
        source: updated.source,
        role: updated.role,
        default_origin: updated.default_origin,
        default_tier: updated.default_tier,
        type_permissions: updated.type_permissions,
        extension_permissions: updated.extension_permissions,
        edge_permissions: updated.edge_permissions,
        created_at: updated.created_at,
        last_used_at: updated.last_used_at,
      },
      200,
    );
  });

  return router;
}
