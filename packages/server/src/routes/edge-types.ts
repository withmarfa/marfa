import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  isCoreEdgeType,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  isValidTypeIdentifier,
} from "@withmarfa/shared";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
  FieldDefinition,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireTenantAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EdgeTypeRequestSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  cardinality: z.enum([
    "one-to-one",
    "one-to-many",
    "many-to-one",
    "many-to-many",
  ]),
  source_type_constraints: z.array(z.string()).optional(),
  target_type_constraints: z.array(z.string()).optional(),
  cascade_on_delete: z.enum(["cascade", "orphan", "block"]).optional(),
  property_schema: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        description: z.string().optional(),
        required: z.boolean().optional(),
        enum_values: z.array(z.string()).optional(),
        items_type: z.string().optional(),
      }),
    )
    .optional(),
});

const EdgeTypeResponseSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  cardinality: z.enum([
    "one-to-one",
    "one-to-many",
    "many-to-one",
    "many-to-many",
  ]),
  source_type_constraints: z.array(z.string()),
  target_type_constraints: z.array(z.string()),
  cascade_on_delete: z.enum(["cascade", "orphan", "block"]),
  property_schema: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const createEdgeTypeRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createEdgeType",
  tags: ["Edge Types"],
  summary: "Register an edge type",
  description:
    "Registers a custom edge type with its cardinality, cascade behaviour, type constraints, and optional property schema. Tenant-admin or platform-admin; the registration is scoped to the caller's tenant and is invisible to other tenants. The eight core edge-type names are reserved and reject with a conflict, and custom types are flat with no inheritance.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: EdgeTypeRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ edge_type: EdgeTypeResponseSchema }),
        },
      },
      description: "Edge type registered",
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
      description: "Validation error",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Tenant-admin required",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "Edge type already exists",
    },
  },
});

const listEdgeTypesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listEdgeTypes",
  tags: ["Edge Types"],
  summary: "List edge types",
  description:
    "Returns every edge type registered in the tenant — the eight core types plus any custom registrations — each with its cardinality, cascade behaviour, and source/target type constraints.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            edge_types: z.array(EdgeTypeResponseSchema),
          }),
        },
      },
      description: "Edge types",
    },
  },
});

const deleteEdgeTypeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteEdgeType",
  tags: ["Edge Types"],
  summary: "Delete an edge type",
  description:
    "Removes a custom edge type registration scoped to the caller's tenant. Tenant-admin or platform-admin; core edge types are rejected, another tenant's edge type resolves as not-found, and the request fails while any edges of this type still exist, so delete or migrate them first.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().describe("Edge type id.") }) },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Deleted",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Can't delete a core edge type",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_type_not_found"]),
        },
      },
      description: "Edge type not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function edgeTypeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createEdgeTypeRoute, async (c) => {
    requireTenantAdmin(c);
    const body = c.req.valid("json");
    // Check core-type protection first — matches the client-facing
    // expectation that "can't redefine a core type" is a 409, not
    // a 400 shape check.
    if (isCoreEdgeType(body.id)) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `${body.id} is a core edge type and cannot be redefined`,
      );
    }
    if (!isValidTypeIdentifier(body.id) && !body.id.includes("-")) {
      // Custom edge types use `<app>.<kebab-name>` shape; kebab is allowed
      // because core types like `parent-of` set the precedent.
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid edge-type identifier",
      );
    }
    // NQ-1 resolution (custom edges do not inherit): pull the raw body and
    // reject `extends` explicitly. Zod's default .strip() would silently
    // drop it — that's lenient but invites clients to believe it worked.
    const rawBody = await c.req.json<Record<string, unknown>>();
    if ("extends" in rawBody) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Custom edge types do not support `extends`",
      );
    }

    const schema: EdgeTypeSchema = {
      id: body.id,
      ...(body.label !== undefined && { label: body.label }),
      ...(body.description !== undefined && { description: body.description }),
      cardinality: body.cardinality as EdgeCardinality,
      source_type_constraints: body.source_type_constraints ?? ["*"],
      target_type_constraints: body.target_type_constraints ?? ["*"],
      cascade_on_delete: (body.cascade_on_delete ?? "orphan") as EdgeCascade,
      property_schema: (body.property_schema ?? {}) as Record<
        string,
        FieldDefinition
      >,
    };

    const tenantId = c.get("apiKey")?.tenant_id;
    await storage.edgeTypes.create(schema, tenantId);
    registerEdgeTypeSchema(schema, tenantId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge_type.create",
      resource_type: "edge_type",
      resource_id: schema.id,
    });
    return c.json({ edge_type: schema }, 201);
  });

  router.openapi(listEdgeTypesRoute, async (c) => {
    requireTenantAdmin(c);
    // Core types are global; custom types resolve only within the caller's
    // tenant. `listEdgeTypes(tenantId)` returns core plus this tenant's own
    // custom edge types — never another tenant's.
    const tenantId = c.get("apiKey")?.tenant_id;
    const { listEdgeTypes } = await import("@withmarfa/shared");
    return c.json({ edge_types: listEdgeTypes(tenantId) }, 200);
  });

  router.openapi(deleteEdgeTypeRoute, async (c) => {
    requireTenantAdmin(c);
    const { id } = c.req.valid("param");
    if (isCoreEdgeType(id)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${id} is a core edge type and cannot be deleted`,
      );
    }
    const tenantId = c.get("apiKey")?.tenant_id;
    // Tenant-scoped lookup: a tenant_admin can only see (and so delete) its
    // own custom edge types. A probe for another tenant's id resolves to
    // nothing here and 404s — cross-tenant deletes are impossible.
    const existing = await storage.edgeTypes.get(id, tenantId);
    if (!existing) {
      throw new MarfaError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Edge type ${id} not found`,
      );
    }
    await storage.edgeTypes.delete(id, tenantId);
    unregisterEdgeTypeSchema(id, tenantId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge_type.delete",
      resource_type: "edge_type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
