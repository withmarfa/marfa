import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  isCoreEdgeType,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  isValidEdgeTypeIdentifier,
  isRoleConstraint,
  roleFromConstraint,
  TYPE_ROLES,
  ROLE_CONSTRAINT_PREFIX,
} from "@withmarfa/shared";
import type { EdgeTypeSchema, FieldDefinition } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requirePermission,
  requireAuth,
  requireMetadataPermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * One entry in a type-constraint list: `*`, a type identifier, or
 * `role:<name>` naming one of the closed set of structural roles.
 *
 * The role names are checked here rather than left to edge-creation time. An
 * unknown role matches no type, so the edge would refuse every endpoint while
 * reading as though it admitted a family of them, and the refusal would
 * surface on somebody else's write rather than on the registration that
 * caused it.
 */
const TypeConstraintSchema = z
  .string()
  .min(1)
  .refine(
    (entry) =>
      !isRoleConstraint(entry) || roleFromConstraint(entry) !== undefined,
    {
      message: `Unknown role constraint. Known roles: ${TYPE_ROLES.map(
        (r) => `${ROLE_CONSTRAINT_PREFIX}${r}`,
      ).join(", ")}`,
    },
  );

/** Exported so the archive restore validates a carried edge type through
 *  exactly the shape this route accepts, rather than a second reading of
 *  the same rules that can drift from it. */
export const EdgeTypeRequestSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  cardinality: z.enum([
    "one-to-one",
    "one-to-many",
    "many-to-one",
    "many-to-many",
  ]),
  source_type_constraints: z.array(TypeConstraintSchema).optional(),
  target_type_constraints: z.array(TypeConstraintSchema).optional(),
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
    "Registers an edge type with its cardinality, cascade behavior, type constraints, and optional property schema. Requires `metadata.edge_types:write`. The eight core edge-type names are reserved and reject with a conflict, and a registered edge type is flat with no inheritance.",
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
      description: "`metadata.edge_types:write` required",
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
    "Returns every edge type this instance resolves — the eight core types plus any registered through `POST /edge-types` — each with its cardinality, cascade behavior, and source/target type constraints.",
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
    "Removes a registered edge type. Requires `schema.write`; core edge types are rejected, and an edge type this instance does not hold resolves as not-found. Existing edges are not consulted and not touched: the registration goes, the rows stay, and they keep naming an edge type the instance no longer holds. Delete or migrate them first if that is not what you want.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "The credential does not hold `schema.write`",
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
    // Registering an edge type is gated by the metadata.edge_types
    // scope, which every credential must carry: `metadata.edge_types:write`
    // is requestable but not part of the default consent bundle, so an app
    // that registers edge types asks for it explicitly. Mirrors
    // `POST /types`.
    requireMetadataPermission(c, "edge_types", "write");
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
    // A registered edge type uses the `<app>.<kebab-name>` shape, and
    // kebab is allowed because core types like `parent-of` set the
    // precedent. That used to be
    // expressed as `!isValidTypeIdentifier(id) && !id.includes("-")`, which
    // admitted the kebab set by skipping the check for anything hyphenated —
    // so `"-"`, `"MY-EDGE"`, `"a b-c"` and `"../-"` all registered.
    // `isValidEdgeTypeIdentifier` states the kebab form instead of exempting
    // it.
    if (!isValidEdgeTypeIdentifier(body.id)) {
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
        "A registered edge type does not support `extends`",
      );
    }

    const schema: EdgeTypeSchema = {
      id: body.id,
      ...(body.label !== undefined && { label: body.label }),
      ...(body.description !== undefined && { description: body.description }),
      cardinality: body.cardinality,
      source_type_constraints: body.source_type_constraints ?? ["*"],
      target_type_constraints: body.target_type_constraints ?? ["*"],
      cascade_on_delete: body.cascade_on_delete ?? "orphan",
      property_schema: (body.property_schema ?? {}) as Record<
        string,
        FieldDefinition
      >,
    };

    await storage.edgeTypes.create(schema);
    registerEdgeTypeSchema(schema);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge_type.create",
      resource_type: "edge_type",
      resource_id: schema.id,
    });
    return c.json({ edge_type: schema }, 201);
  });

  router.openapi(listEdgeTypesRoute, async (c) => {
    requireAuth(c);
    const { listEdgeTypes } = await import("@withmarfa/shared");
    return c.json({ edge_types: listEdgeTypes() }, 200);
  });

  router.openapi(deleteEdgeTypeRoute, async (c) => {
    requireAuth(c);
    requirePermission(c, "schema.write");
    const { id } = c.req.valid("param");
    if (isCoreEdgeType(id)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${id} is a core edge type and cannot be deleted`,
      );
    }
    const existing = await storage.edgeTypes.get(id);
    if (!existing) {
      throw new MarfaError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Edge type ${id} not found`,
      );
    }
    await storage.edgeTypes.delete(id);
    unregisterEdgeTypeSchema(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge_type.delete",
      resource_type: "edge_type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
