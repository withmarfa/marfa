import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MymeError,
  isCoreEdgeType,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  isValidTypeIdentifier,
} from "@mymehq/shared";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
  FieldDefinition,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
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
  path: "/types",
  tags: ["EdgeTypes"],
  summary: "Register an edge type",
  description:
    "Registers a custom edge type. Carries `cardinality` (`one-to-one` / `one-to-many` / `many-to-one` / `many-to-many`), `cascade_on_delete` (`cascade` / `orphan` / `block`), source and target type constraints, and an optional `property_schema`. Core edge type names (`about`, `parent-of`, `in-thread`, `attached-to`, `references`, `authored-by`, `derived-from`, `supersedes`) are reserved and collide with `409 conflict`.\n\nAdmin-only. Custom edge types do not inherit — they're flat. See [Edges — custom edge types](/concepts/edges#custom-edge-types).",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Admin required",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Edge type already exists",
    },
  },
});

const listEdgeTypesRoute = createRoute({
  method: "get",
  path: "/types",
  tags: ["EdgeTypes"],
  summary: "List edge types",
  description:
    "Returns every edge type registered in the tenant — the eight core types (`about`, `parent-of`, `in-thread`, `attached-to`, `references`, `authored-by`, `derived-from`, `supersedes`) plus any custom types registered via `POST /edges/types`. Each entry carries its cardinality, cascade behaviour, and source/target type constraints.",
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
  path: "/types/{id}",
  tags: ["EdgeTypes"],
  summary: "Delete an edge type",
  description:
    "Removes a custom edge type registration. Core edge types are immutable and rejected with 400. If existing edges of this type remain, the request fails — delete or migrate them first. Admin-only.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Deleted",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Can't delete a core edge type",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    requireAdmin(c);
    const body = c.req.valid("json");
    // Check core-type protection first — matches the client-facing
    // expectation that "can't redefine a core type" is a 409, not
    // a 400 shape check.
    if (isCoreEdgeType(body.id)) {
      throw new MymeError(
        ErrorCode.CONFLICT,
        `${body.id} is a core edge type and cannot be redefined`,
      );
    }
    if (!isValidTypeIdentifier(body.id) && !body.id.includes("-")) {
      // Custom edge types use `<app>.<kebab-name>` shape; kebab is allowed
      // because core types like `parent-of` set the precedent.
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid edge-type identifier",
      );
    }
    // NQ-1 resolution (custom edges do not inherit): pull the raw body and
    // reject `extends` explicitly. Zod's default .strip() would silently
    // drop it — that's lenient but invites clients to believe it worked.
    const rawBody = await c.req.json<Record<string, unknown>>();
    if ("extends" in rawBody) {
      throw new MymeError(
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
    registerEdgeTypeSchema(schema);
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
    // Core types are always available from the in-memory registry; merge
    // custom types from storage. Use listEdgeTypes from shared for the
    // unified view (loads both).
    const { listEdgeTypes } = await import("@mymehq/shared");
    return c.json({ edge_types: listEdgeTypes() }, 200);
  });

  router.openapi(deleteEdgeTypeRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (isCoreEdgeType(id)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `${id} is a core edge type and cannot be deleted`,
      );
    }
    const existing = await storage.edgeTypes.get(id);
    if (!existing) {
      throw new MymeError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Edge type ${id} not found`,
      );
    }
    await storage.edgeTypes.delete(id);
    unregisterEdgeTypeSchema(id);
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
