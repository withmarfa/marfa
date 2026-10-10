import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { wholeListOf } from "./_schemas.js";
import {
  ErrorCode,
  MarfaError,
  isCoreEdgeType,
  isValidEdgeTypeIdentifier,
  edgeNameHolder,
  getEdgeTypeSchema,
  isRoleConstraint,
  roleFromConstraint,
  TYPE_ROLES,
  ROLE_CONSTRAINT_PREFIX,
  FIELD_TYPES,
  unreadKeys,
} from "@withmarfa/shared";
import type { EdgeTypeSchema, FieldDefinition } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import {
  changesSchema,
  registersEdgeType,
  requireEdgeTypeSchemaWrite,
} from "./_schema-reach.js";

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
    "The property's type: one of the field types a type's `fields` take, except `thumbnail`.",
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
    "A refinement of a `string` property, such as `bcp47`. It can't be `thumbnail`: an edge carries no thumbnail.",
  );

/** One property an edge of the type carries, as registration takes it and
 *  the type answers it. */
export const EdgePropertyDefinitionSchema = z
  .object({
    type: EdgePropertyTypeSchema,
    description: z.string().optional().describe("What the property holds."),
    required: z
      .boolean()
      .optional()
      .describe("`true` if every edge of the type should have the property."),
    enum_values: z
      .array(z.string())
      .optional()
      .describe("The values an `enum` property takes."),
    items_type: EdgePropertyTypeSchema.optional().describe(
      "The type of each element of an `array` property. It can't be `thumbnail`.",
    ),
    format: EdgePropertyFormatSchema.optional(),
  })
  .describe("One property an edge of an edge type can carry.")
  .openapi("EdgePropertyDefinition");

// The texts the request and the answer share. The request adds what leaving
// a field out does.
const LABEL = "A name for people to read.";
const DESCRIPTION = "What the edge type is for.";
const CardinalitySchema = z
  .enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"])
  .describe(
    "How many edges of the type an item can hold. `one-to-one`: each source and each target holds one. `one-to-many`: each target holds one. `many-to-one`: each source holds one. `many-to-many`: no limit.",
  );
const SOURCE_CONSTRAINTS =
  "The types an edge's source item can have: `*`, a type identifier or `role:<name>`. A type matches its subtypes.";
const TARGET_CONSTRAINTS =
  "The types an edge's target item can have, in the same form as `source_type_constraints`.";
const CASCADE =
  "What happens when an item an edge joins is deleted. `cascade`: deleting the source trashes the target. `orphan`: the other item stays. `block`: the delete fails while the edge exists.";
const PROPERTY_SCHEMA =
  "The properties an edge of the type can carry, by name, for clients to read. Marfa doesn't check edges against it.";
const REVERSE_NAME =
  "The name the edge goes by when read from its target, such as `child-of` for `parent-of`.";
const WRITTEN_AT =
  "The end of an edge whose file writes it in a folder: `source`, or `target` under the reverse name.";

/** Exported so the archive restore validates a carried edge type through
 *  exactly the shape this route accepts, rather than a second reading of
 *  the same rules that can drift from it. */
export const EdgeTypeRequestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The identifier of the edge type, such as `acme.list-member`."),
    label: z.string().optional().describe(LABEL),
    description: z.string().optional().describe(DESCRIPTION),
    cardinality: CardinalitySchema,
    source_type_constraints: z
      .array(TypeConstraintSchema)
      .optional()
      .describe(`${SOURCE_CONSTRAINTS} Leave it out to allow any type.`),
    target_type_constraints: z
      .array(TypeConstraintSchema)
      .optional()
      .describe(`${TARGET_CONSTRAINTS} Leave it out to allow any type.`),
    cascade_on_delete: z
      .enum(["cascade", "orphan", "block"])
      .optional()
      .describe(`${CASCADE} Leave it out for \`orphan\`.`),
    property_schema: z
      .record(z.string(), EdgePropertyDefinitionSchema)
      .optional()
      .describe(`${PROPERTY_SCHEMA} Leave it out for none.`),
    reverse_name: z
      .string()
      .optional()
      .describe(
        `${REVERSE_NAME} No other edge type can use it as an ID or reverse name.`,
      ),
    written_at: z
      .enum(["source", "target"])
      .optional()
      .describe(
        `${WRITTEN_AT} \`target\` needs a \`reverse_name\`. Leave it out for \`source\`.`,
      ),
  })
  .describe("An edge type to register.")
  .openapi("EdgeTypeRequest");

const EdgeTypeResponseSchema = z
  .object({
    id: z.string().describe("Unique identifier for the edge type."),
    label: z.string().optional().describe(LABEL),
    description: z.string().optional().describe(DESCRIPTION),
    cardinality: CardinalitySchema,
    source_type_constraints: z.array(z.string()).describe(SOURCE_CONSTRAINTS),
    target_type_constraints: z.array(z.string()).describe(TARGET_CONSTRAINTS),
    cascade_on_delete: z.enum(["cascade", "orphan", "block"]).describe(CASCADE),
    property_schema: z
      .record(z.string(), EdgePropertyDefinitionSchema)
      .describe(PROPERTY_SCHEMA),
    reverse_name: z.string().optional().describe(REVERSE_NAME),
    written_at: z.enum(["source", "target"]).describe(WRITTEN_AT),
    shipped: z
      .boolean()
      .describe(
        "`true` if Marfa ships the edge type: it exists on every instance, and you can't register or delete it. `false` for one registered through `POST /edge-types`.",
      ),
  })
  .describe(
    "An edge type says how edges of that type behave: its cardinality, what a delete does to the items they join, and which item types they can join.",
  )
  .openapi("EdgeType");

function edgeTypeResponse(schema: EdgeTypeSchema) {
  return { ...schema, shipped: isCoreEdgeType(schema.id) };
}

/**
 * Refuses an id or a reverse name another edge type holds as either. A folder
 * reads a frontmatter key as the edge type it names, so each such name
 * belongs to one type. Synchronous, so a caller that registers straight after
 * it leaves no await in which another registration can take the name.
 */
export function assertEdgeNamesFree(
  id: string,
  reverse: string | undefined,
  taken: ReadonlyMap<string, string> = new Map(),
): void {
  const claims: ["id" | "reverse_name", string][] = [["id", id]];
  if (reverse !== undefined) claims.push(["reverse_name", reverse]);
  for (const [field, name] of claims) {
    const holder = edgeNameHolder(name, id) ?? taken.get(name);
    if (holder !== undefined && holder !== id) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `"${name}" is already a name of the edge type ${holder}`,
        { field, held_by: holder },
      );
    }
  }
}

/**
 * Refuses a key the edge type, or one of its properties, does not take.
 *
 * The keys are asked of the body as it was sent, because the request schema
 * strips what it does not declare. A refusal names each key's path. The route
 * and an archive restore share it, so neither is the laxer door.
 */
export function refuseUnreadEdgeTypeKeys(
  sent: unknown,
  message = "Invalid edge type schema",
): void {
  const errors = unreadKeys(sent, "edge");
  if (errors.length > 0) {
    throw new MarfaError(ErrorCode.INVALID_SCHEMA, message, { errors });
  }
}

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
  const unknownTypes = Object.entries(body.property_schema ?? {})
    .filter(
      ([, property]) =>
        !(FIELD_TYPES as readonly string[]).includes(property.type),
    )
    .map(([name, property]) => ({
      field: `property_schema.${name}.type`,
      expected: `one of: ${FIELD_TYPES.join(", ")}`,
      actual: property.type,
      message: `"${property.type}" is not a field type`,
    }));
  if (unknownTypes.length > 0) {
    throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid edge type schema", {
      errors: unknownTypes,
    });
  }
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
  assertEdgeNamesFree(body.id, reverse, taken);
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

const registerEdgeTypeRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "registerEdgeType",
  tags: ["Edge types"],
  summary: "Register an edge type",
  description:
    "Registers an edge type and returns it. An edge type can't extend another.",
  security: [{ bearerAuth: [] }],
  middleware: registersEdgeType,
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
      description: "Returns the new edge type.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_schema",
          ]),
        },
      },
      description:
        "- `validation_error`: a field is invalid, such as an `id` or `reverse_name` that isn't a valid edge type identifier, a `role:` constraint naming no role, or `written_at: target` with no `reverse_name`; or the body names `extends`.\n- `missing_required_field`: `id` or `cardinality` is missing.\n- `invalid_schema`: a property's `type` isn't a field type, or the body has a key the edge type or a property doesn't define (`details.errors` names each key's path).",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "- `forbidden`: you don't have `metadata.edge_types:write`.\n- `edge_permission_denied`: your edge map doesn't grant write on `id` or `reverse_name`. `details.edge_type` names it.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "`conflict`: `id` is the name of an edge type Marfa ships, `id` or `reverse_name` is already the ID or reverse name of an edge type, or `reverse_name` equals `id`.",
    },
  },
});

const listEdgeTypesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listEdgeTypes",
  tags: ["Edge types"],
  summary: "List edge types",
  description:
    "Returns every edge type on this instance: those Marfa ships and those registered through `POST /edge-types`. Every credential reads the whole list, whatever its edge map reaches.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            EdgeTypeResponseSchema,
            "EdgeTypePage",
            "edge type",
          ),
        },
      },
      description:
        "Returns every edge type. `shipped` tells the two kinds apart.",
    },
  },
});

const deleteEdgeTypeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteEdgeType",
  tags: ["Edge types"],
  summary: "Delete an edge type",
  description:
    "Deletes a registered edge type. With `force=true`, edges of the type stay and keep naming it.",
  security: [{ bearerAuth: [] }],
  middleware: changesSchema,
  request: {
    params: z.object({
      id: z.string().describe("The identifier of the edge type."),
    }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Delete the edge type even though edges of it exist. Those edges stay and keep naming it.",
        ),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "`validation_error`: Marfa ships this edge type, and no credential can delete it.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "- `forbidden`: you don't have `schema.write`.\n- `edge_permission_denied`: your edge map doesn't grant write on the edge type or its `reverse_name`. `details.edge_type` names it.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_type_not_found"]),
        },
      },
      description: "`edge_type_not_found`: no edge type has this identifier.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_type_in_use"]),
        },
      },
      description:
        "`edge_type_in_use`: edges of this type exist. Send `force=true` to delete it anyway.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function edgeTypeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(registerEdgeTypeRoute, async (c) => {
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
    // A reverse name is claimed as an id is, so it is asked too: otherwise
    // one key could take a name another key was minted for.
    requireEdgeTypeSchemaWrite(c, "register", [body.id, body.reverse_name]);
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
    refuseUnreadEdgeTypeKeys(rawBody);

    // Names are checked under the writer lock so concurrent registrations
    // cannot both take the same forward or reverse name.
    const schema = await runAuditedTransaction(
      storage,
      async () => {
        if (getEdgeTypeSchema(body.id)) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `Edge type ${body.id} already exists`,
          );
        }
        const built = edgeTypeFromRequest(body);
        await storage.edgeTypes.create(built);
        return built;
      },
      (schema) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "edge_type.register",
        resource_type: "edge_type",
        resource_id: schema.id,
      }),
    );

    return c.json({ edge_type: edgeTypeResponse(schema) }, 201);
  });

  router.openapi(listEdgeTypesRoute, async (c) => {
    requireAuth(c);
    const { listEdgeTypes } = await import("@withmarfa/shared");
    return c.json(
      { data: listEdgeTypes().map(edgeTypeResponse), next_cursor: null },
      200,
    );
  });

  router.openapi(deleteEdgeTypeRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (isCoreEdgeType(id)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${id} is a core edge type and cannot be deleted`,
      );
    }
    const { force } = c.req.valid("query");
    // The existence check, the question and the delete are one transaction.
    // An edge write asks the table inside its own, so it is either counted
    // here or refused once the row is gone, and of two deletes in flight the
    // second finds no row.
    await runAuditedTransaction(
      storage,
      async () => {
        const existing = await storage.edgeTypes.get(id);
        if (!existing) {
          throw new MarfaError(
            ErrorCode.EDGE_TYPE_NOT_FOUND,
            `Edge type ${id} not found`,
          );
        }
        requireEdgeTypeSchemaWrite(c, "change", [id, existing.reverse_name]);
        // The sibling's shape, asked the same way: one row of the type is
        // enough to know, so the query is bounded rather than a count.
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
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "edge_type.delete",
        resource_type: "edge_type",
        resource_id: id,
      },
    );

    return c.json({ ok: true as const }, 200);
  });

  return router;
}
