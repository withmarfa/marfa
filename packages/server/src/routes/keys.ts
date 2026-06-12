import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireTenantAdmin, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

const KEY_PREFIX = "marfa_k1_";

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
  role: z.enum(["admin", "tenant_admin", "member"]),
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
  operationId: "createKey",
  method: "post",
  path: "/",
  tags: ["Keys"],
  summary: "Create an API key",
  description:
    "Creates a new API key in the caller's tenant. The plaintext `key` is returned only in this response and never shown again, so store it securely. On a fresh server with zero keys, this runs in bootstrap mode (no auth, minted key is always admin); once any key exists, creation requires an admin or tenant_admin token.",
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
            role: z.enum(["admin", "tenant_admin", "member"]).optional(),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const listKeysRoute = createRoute({
  operationId: "listKeys",
  method: "get",
  path: "/",
  tags: ["Keys"],
  summary: "List API keys",
  description:
    "Returns every API key in the caller's tenant without plaintext, which is only ever returned at creation time. `last_used_at` is debounced to at most one write per hour, so treat it as a coarse activity signal rather than an audit log. Admin or tenant_admin only.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const revokeKeyRoute = createRoute({
  operationId: "revokeKey",
  method: "delete",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Revoke an API key",
  description:
    "Revokes the key immediately; the next request bearing it returns `401 unauthorized`. In-flight long-lived connections (SSE) terminate on the next heartbeat. Admin or tenant_admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the API key to revoke"),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
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
  role: z.enum(["admin", "tenant_admin", "member"]),
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
  operationId: "updateKey",
  method: "patch",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Update an API key",
  description:
    "Updates a key's label, default tier, or permission maps in place. `source` and `role` are immutable and rejected with `400 validation_error` if present in the body — revoke and recreate to change them. Admin or tenant_admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the API key to update"),
    }),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Invalid update (e.g. attempt to mutate an immutable field)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Admin only",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["api_key_not_found"]),
        },
      },
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
      requireTenantAdmin(c);
      // OAuth principals carry the user's projected role but are scope-limited
      // grants, not the user acting directly. Minting an API key produces a
      // durable credential that bypasses the permission maps the OAuth token is
      // held to — so an app granted a narrow scope could escalate it into full
      // tenant access. Block key creation for OAuth callers; they keep
      // read/manage reach via the role projection but cannot forge a
      // non-scope-enforced key. (`authType` is set by the bearer middleware.)
      if (c.get("authType") === "oauth") {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "OAuth access tokens cannot create API keys; authenticate with an API key to mint one.",
        );
      }
    }

    // Under bootstrap, atomically claim the sentinel BEFORE minting. Two
    // concurrent unauthenticated POST /keys against a fresh DB both pass
    // the middleware gate (which reads the sentinel non-atomically); only
    // the caller whose INSERT-ON-CONFLICT-DO-NOTHING returns a row gets to
    // mint. Everyone else falls through to requireAdmin and receives 401.
    if (isBootstrap) {
      const claimed = await storage.settings.claim("bootstrapped", "true");
      if (!claimed) {
        throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
      }
    }

    const body = c.req.valid("json");

    const role = isBootstrap ? "admin" : (body.role ?? "member");

    const typePermissions = body.type_permissions ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    // is_platform escalation requires the caller to already be platform.
    // Bootstrap is exempted — the seed key is implicitly platform.
    const callerIsPlatform = c.get("apiKey")?.is_platform === true;
    let isPlatform: boolean;
    if (isBootstrap) {
      isPlatform = body.is_platform ?? true;
    } else {
      isPlatform = callerIsPlatform && body.is_platform === true;
    }

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

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: isBootstrap ? "key.bootstrap" : "key.create",
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
    // tenant_admin sees only its own tenant's keys; admin (no tenant_id)
    // sees all. Cross-tenant visibility is fenced at the application layer
    // here and at the DB layer when RLS enforcement is on.
    const key = requireTenantAdmin(c);
    const all = await storage.keys.list();
    const visible =
      key.role === "tenant_admin" && key.tenant_id
        ? all.filter((k) => k.tenant_id === key.tenant_id)
        : all;
    return c.json({ keys: visible }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // 404 not 403 — cross-tenant probes must not enumerate key ids.
    if (key.role === "tenant_admin" && key.tenant_id) {
      const target = await storage.keys.get(id);
      if (target?.tenant_id !== key.tenant_id) {
        throw new MarfaError(
          ErrorCode.API_KEY_NOT_FOUND,
          `Key ${id} not found`,
        );
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
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    if ("source" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`source` is immutable after creation — it is baked into item provenance. Revoke and issue a new key instead.",
      );
    }
    if ("role" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`role` is immutable after creation for security reasons. Revoke and issue a new key instead.",
      );
    }

    const existing = await storage.keys.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }
    if (
      key.role === "tenant_admin" &&
      key.tenant_id &&
      existing.tenant_id !== key.tenant_id
    ) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
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
