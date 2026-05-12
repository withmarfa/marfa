import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireWorkspaceAdmin, hashApiKey } from "../middleware/auth.js";
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
  role: z.enum(["admin", "workspace_admin", "member"]),
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  metadata_permissions: z
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
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  metadata_permissions: z
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
  summary: "Create an API key",
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
            role: z.enum(["admin", "workspace_admin", "member"]).optional(),
            default_tier: z.enum(["library", "feed"]).optional(),
            is_platform: z.boolean().optional(),
            type_permissions: z
              .record(z.string(), z.enum(["read", "write", "none"]))
              .optional(),
            extension_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
            edge_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
            metadata_permissions: z
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
  summary: "List API keys",
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
  default_tier: z.enum(["library", "feed"]).optional(),
  type_permissions: z
    .record(z.string(), z.enum(["read", "write", "none"]))
    .optional(),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  source: z.unknown().optional(),
  role: z.unknown().optional(),
});

const KeyDetailSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.enum(["admin", "workspace_admin", "member"]),
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const updateKeyRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Update an API key",
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
      // T-051: workspace_admin can mint own-tenant keys. The new key's
      // tenant_id is stamped from the caller's tenant_id in the storage
      // layer; `is_platform` is coerced to `false` unless the caller is
      // itself platform (see line ~310 below), so a workspace_admin
      // cannot escalate to platform via the request body.
      requireWorkspaceAdmin(c);
    }

    // T-007: under bootstrap, atomically claim the workspace sentinel
    // BEFORE minting. Two concurrent unauthenticated POST /keys against a
    // fresh DB both pass the middleware gate (which reads the sentinel
    // non-atomically); only the caller whose INSERT-ON-CONFLICT-DO-NOTHING
    // returns a row gets to mint. Everyone else falls through to
    // requireAdmin and receives 401, which is correct because by then
    // bootstrap is closed.
    if (isBootstrap) {
      const claimed = await storage.settings.claim("bootstrapped", "true");
      if (!claimed) {
        throw new MymeError(ErrorCode.UNAUTHORIZED, "Authentication required");
      }
    }

    const body = c.req.valid("json");

    const role = isBootstrap ? "admin" : (body.role ?? "member");

    const typePermissions = body.type_permissions ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    // Platform-credential gate (TSC42 §3/§4): only an existing platform
    // credential can mint another. Bootstrap is a special case — the very
    // first credential created at install time IS the seed platform
    // credential, so we accept the request body's flag (or default to true
    // when bootstrapping). After that, callers without is_platform: true
    // see their request silently coerced to false.
    const callerIsPlatform = c.get("apiKey")?.is_platform === true;
    let isPlatform: boolean;
    if (isBootstrap) {
      isPlatform = body.is_platform ?? true;
    } else {
      isPlatform = callerIsPlatform && body.is_platform === true;
    }

    // T-051: stamp the new key's tenant_id from the caller's tenant_id
    // so a workspace_admin minting an own-tenant key gets the binding
    // automatically. Bootstrap is a special case — the seed admin is
    // stamped tenant-less (NULL) so it can write across tenants until a
    // hosted-mode tenant is created. Platform admins on a single-tenant
    // self-host also have tenant_id undefined; that path is unchanged.
    const newKeyTenantId = c.get("apiKey")?.tenant_id;

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: role,
        default_tier: body.default_tier,
        is_platform: isPlatform,
        type_permissions: typePermissions,
        extension_permissions: body.extension_permissions,
        edge_permissions: body.edge_permissions,
        metadata_permissions: body.metadata_permissions,
      },
      keyHash,
      newKeyTenantId,
    );

    // The bootstrap sentinel was stamped above via `settings.claim`, so the
    // post-mint write is no longer needed. (Pre-T-007 the sentinel was
    // stamped after the mint, which left a window for concurrent calls to
    // both pass the gate and both mint admin keys.)

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
        default_tier: stored.default_tier,
        is_platform: stored.is_platform,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    // T-051 follow-on (Wave B Part 2): widened from `requireAdmin`
    // to `requireWorkspaceAdmin`. workspace_admin sees only its own
    // tenant's keys; admin (no tenant_id) sees all. Cross-tenant
    // visibility is fenced at the application layer here AND at the
    // DB layer (T-025 RLS) when enforcement is on.
    const key = requireWorkspaceAdmin(c);
    const all = await storage.keys.list();
    const visible =
      key.role === "workspace_admin" && key.tenant_id
        ? all.filter((k) => k.tenant_id === key.tenant_id)
        : all;
    return c.json({ keys: visible }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const key = requireWorkspaceAdmin(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // workspace_admin can only revoke keys in its own tenant —
    // surface as 404 so cross-tenant probes can't enumerate ids.
    if (key.role === "workspace_admin" && key.tenant_id) {
      const target = await storage.keys.get(id);
      if (target?.tenant_id !== key.tenant_id) {
        throw new MymeError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
      }
    }

    await storage.keys.revoke(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "key.revoke",
      resource_type: "key",
      resource_id: id,
    });

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateKeyRoute, async (c) => {
    const key = requireWorkspaceAdmin(c);
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
      throw new MymeError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }
    // workspace_admin can only update keys in its own tenant — same
    // 404 cloak as revoke.
    if (
      key.role === "workspace_admin" &&
      key.tenant_id &&
      existing.tenant_id !== key.tenant_id
    ) {
      throw new MymeError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }

    const updated = await storage.keys.update(id, {
      label: body.label,
      default_tier: body.default_tier,
      type_permissions: body.type_permissions,
      extension_permissions: body.extension_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
        default_tier: updated.default_tier,
        is_platform: updated.is_platform,
        type_permissions: updated.type_permissions,
        extension_permissions: updated.extension_permissions,
        edge_permissions: updated.edge_permissions,
        metadata_permissions: updated.metadata_permissions,
        created_at: updated.created_at,
        last_used_at: updated.last_used_at,
      },
      200,
    );
  });

  return router;
}
