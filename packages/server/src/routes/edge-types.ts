import { createRoute, z } from "@hono/zod-openapi";
import { pageOf } from "./_schemas.js";
import {
  ErrorCode,
  MarfaError,
  isCoreEdgeType,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  isValidEdgeTypeIdentifier,
  edgeNameHolder,
  getEdgeTypeSchema,
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

/** Nothing reads a thumbnail from an edge, and a value nothing reads is a
 *  value nothing checks. */
const EdgePropertyTypeSchema = z
  .string()
  .refine((type) => type !== "thumbnail", {
    message: "An edge never carries a thumbnail",
  })
  .describe(
    "A field type's name, stored as given rather than checked against the ones a type's `fields` take, and never `thumbnail`: an edge carries no thumbnail.",
  );

/** Declared so the format that stands for a thumbnail on a type's field is
 *  refused here, where an undeclared key would be dropped and the edge type
 *  registered as though it named none. */
const EdgePropertyFormatSchema = z
  .string()
  .refine((format) => format !== "thumbnail", {
    message: "An edge never carries a thumbnail",
  })
  .describe(
    "A refinement of a string property, stored as given, and never `thumbnail`: an edge carries no thumbnail.",
  );

/** Exported so the archive restore validates a carried edge type through
 *  exactly the shape this route accepts, rather than a second reading of
 *  the same rules that can drift from it. */
export const EdgeTypeRequestSchema = z
  .object({
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
          type: EdgePropertyTypeSchema,
          description: z.string().optional(),
          required: z.boolean().optional(),
          enum_values: z.array(z.string()).optional(),
          items_type: EdgePropertyTypeSchema.optional(),
          format: EdgePropertyFormatSchema.optional(),
        }),
      )
      .optional(),
    reverse_name: z
      .string()
      .optional()
      .describe(
        "The name the edge goes by read from its target, such as `child-of` for `parent-of`. It takes the edge-type identifier grammar, and no other edge type may hold it as an id or a reverse name.",
      ),
    written_at: z
      .enum(["source", "target"])
      .optional()
      .describe(
        "The end whose file writes an edge of this type, `source` unless named. Where the file at that end cannot carry frontmatter, the other end writes it under the name read from there. `target` needs a `reverse_name`.",
      ),
  })
  .openapi("EdgeTypeRequest");

const EdgeTypeResponseSchema = z
  .object({
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
    reverse_name: z.string().optional(),
    written_at: z.enum(["source", "target"]),
  })
  .openapi("EdgeType");

/**
 * The schema a registration stores, from a body the request schema accepted.
 * The route and an archive restore both build it here, so a type that
 * round-trips through an export compares equal and neither door is the laxer
 * one. `taken` maps names claimed earlier in the same batch to their type.
 */
export function edgeTypeFromRequest(
  body: z.infer<typeof EdgeTypeRequestSchema>,
  taken: ReadonlyMap<string, string> = new Map(),
): EdgeTypeSchema {
  const reverse = body.reverse_name;
  if (reverse !== undefined && !isValidEdgeTypeIdentifier(reverse)) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid reverse_name: it takes the edge-type identifier grammar",
      { field: "reverse_name" },
    );
  }
  if (body.written_at === "target" && reverse === undefined) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "written_at: target needs a reverse_name, the name the target's file writes the edge under",
      { field: "written_at" },
    );
  }
  if (reverse === body.id) {
    throw new MarfaError(
      ErrorCode.CONFLICT,
      "A reverse name cannot be the edge type's own id",
      { field: "reverse_name", held_by: body.id },
    );
  }
  // A folder reads a frontmatter key as the edge type it names, so each such
  // name, an id or a reverse name, belongs to one type.
  const claims: ["id" | "reverse_name", string][] = [["id", body.id]];
  if (reverse !== undefined) claims.push(["reverse_name", reverse]);
  for (const [field, name] of claims) {
    const holder = edgeNameHolder(name, body.id) ?? taken.get(name);
    if (holder !== undefined && holder !== body.id) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `"${name}" is already a name of the edge type ${holder}`,
        { field, held_by: holder },
      );
    }
  }
  return {
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
    ...(reverse !== undefined && { reverse_name: reverse }),
    written_at: body.written_at ?? "source",
  };
}

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
    "Registers an edge type with its cardinality, cascade behavior, type constraints, and optional property schema. Requires `metadata.edge_types:write`. The shipped edge-type names are reserved and reject with a conflict, as does an id or a `reverse_name` another edge type already holds as either, and a registered edge type is flat with no inheritance.",
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
      description: "Edge type already exists, or a name it claims is held",
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
    "Returns every edge type this instance resolves — the shipped types plus any registered through `POST /edge-types` — each with its cardinality, cascade behavior, source/target type constraints, and the reverse name it declares, if any.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(EdgeTypeResponseSchema, "EdgeTypePage"),
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
    "Removes a registered edge type. Requires `schema.write`; core edge types are rejected, and an edge type this instance does not hold resolves as not-found. Refused `409 edge_type_in_use` while any edge of the type is stored, the shape the sibling `DELETE /types/{id}` has for items. `?force=true` deletes the registration anyway and leaves those edges in place, still naming a type the instance no longer holds \u2014 it orphans rather than cascades, because deleting rows nobody asked to delete is the worse of the two surprises.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Edge type id.") }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Delete the registration even though edges of the type exist, leaving them naming it.",
        ),
    }),
  },
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
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_type_in_use"]),
        },
      },
      description:
        "Edges of this type are stored. `details.edge_type` names it. Pass `?force=true` to delete the registration anyway and leave them.",
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
    // precedent. The kebab form is stated rather than exempted, so `"-"`,
    // `"MY-EDGE"`, `"a b-c"` and `"../-"` are refused.
    if (!isValidEdgeTypeIdentifier(body.id)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid edge-type identifier",
      );
    }
    // A registered edge type does not inherit: pull the raw body and reject
    // `extends` explicitly. Zod's default .strip() would silently drop it —
    // that's lenient but invites clients to believe it worked.
    const rawBody = await c.req.json<Record<string, unknown>>();
    if ("extends" in rawBody) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "A registered edge type does not support `extends`",
      );
    }

    // The name checks and the registry claim run with nothing awaited
    // between them, so two registrations in flight cannot both take a name;
    // the claim is given back if the row is not written.
    if (getEdgeTypeSchema(body.id)) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Edge type ${body.id} already exists`,
      );
    }
    const schema = edgeTypeFromRequest(body);
    registerEdgeTypeSchema(schema);
    try {
      await storage.edgeTypes.create(schema);
    } catch (err) {
      unregisterEdgeTypeSchema(schema.id);
      throw err;
    }
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
    return c.json({ data: listEdgeTypes(), next_cursor: null }, 200);
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

    // The sibling's shape, asked the same way: one row of the type is
    // enough to know, so the query is bounded rather than a count.
    const { force } = c.req.valid("query");
    if (force !== "true") {
      const inUse = await storage.edges.list({ edge_type: id, limit: 1 });
      if (inUse.data.length > 0) {
        throw new MarfaError(
          ErrorCode.EDGE_TYPE_IN_USE,
          `Edge type "${id}" has existing edges. Use ?force=true to delete anyway, which leaves them naming it.`,
          { edge_type: id },
        );
      }
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
