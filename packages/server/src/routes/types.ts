import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  getTypeSchema,
  directChildrenOf,
  maxDescendantDepth,
  listTypes,
  TYPE_REGISTRY,
  validateTypeSchema,
  isValidTypeIdentifier,
  classifyNamespace,
  diffTypeSchemas,
  isValidVersionBump,
  TYPE_ROLES,
  FIELD_TYPES,
  FIELD_FORMATS,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { Context, Next } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requirePermission,
  requireMetadataPermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { resolveRoles, resolveTypeSchema } from "../storage/policy.js";
import type { TypeResolver } from "../storage/policy.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import { assertParentChain } from "./_parent-chain.js";
import { MergePolicySchema, pageOf } from "./_schemas.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/**
 * Whether an identifier names a type this instance treats as locked.
 *
 * Reads the live registry rather than a set compiled from the shipped arrays,
 * because the platform vocabulary is seeded data now: an instance can hold a
 * type the running build never shipped, and locking has to follow what the
 * instance actually has. `TYPE_REGISTRY` is the platform map — a runtime
 * registration lives in the runtime overlay and never appears in it — so
 * membership is exactly the "shipped, not yours to edit" question.
 *
 * The lock spans core, connector and system alike. A connector type is
 * no more mutable than a core one.
 */
function isLockedPlatformType(id: string): boolean {
  return TYPE_REGISTRY.has(id);
}

/**
 * How `POST /types` and `PUT /types/:id` phrase a rejected chain.
 *
 * `descendantDepth` is what a re-parent has to declare. The cap bounds the
 * chain the write produces, and a type with subtypes carries them with it,
 * so the message says which half ran out of room. A caller told only that
 * the chain is too deep, when the chain they submitted plainly is not, has
 * been given the fact and not the reason.
 */
function validateParentChain(
  typeId: string,
  parentId: string,
  descendantDepth = 0,
): void {
  assertParentChain(
    typeId,
    parentId,
    {
      tooDeep: (maxDepth) =>
        descendantDepth > 0
          ? `Inheritance chain exceeds maximum depth of ${String(maxDepth)}: this type carries ${String(descendantDepth)} level(s) of subtypes, which count toward the limit`
          : `Inheritance chain exceeds maximum depth of ${String(maxDepth)}`,
      circular: () => "Circular inheritance detected",
      unknownParent: (unresolved, parent) =>
        unresolved === parent
          ? `Parent type "${parent}" not found`
          : `Parent type "${parent}" resolves, but its own ancestor "${unresolved}" does not`,
    },
    descendantDepth,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * One field of a type, as `validateTypeSchema` takes it.
 *
 * The vocabularies are the validator's own lists rather than literals
 * repeated here, so a field type added there is declared here without
 * anybody remembering to.
 */
const FieldDefinitionSchema = z
  .looseObject({
    type: z
      .enum(FIELD_TYPES as unknown as [string, ...string[]])
      .describe(
        "`thumbnail` holds a small image the writer supplies: `data:image/png;base64,…`, `image/jpeg` or `image/webp`, canonical base64, at most 16 KiB decoded, beginning with that format's signature. A type carries at most one, never under a name search indexes whatever its type (`title`, `body`, `description`, `name`), and never as an array's `items_type`.",
      ),
    description: z.string().optional(),
    required: z.boolean().optional(),
    enum_values: z.array(z.string()).optional(),
    items_type: z.string().optional(),
    format: z
      .enum(FIELD_FORMATS as unknown as [string, ...string[]])
      .optional()
      .describe(
        "Semantic refinement of a `string` field. Only the annotation-only formats reach the registry: those with a field type of their own normalize into `type`.",
      ),
    searchable: z.boolean().optional(),
    maxLength: z.number().int().optional(),
    maxItems: z.number().int().optional(),
  })
  .openapi("FieldDefinition");

const DisplayHintsSchema = z
  .object({
    title_field: z.string().optional(),
    body_field: z.string().optional(),
  })
  .openapi("DisplayHints");

const LinkFieldSchema = z
  .string()
  .describe(
    "The string field, declared or inherited, holding each row's own id at the vendor that writes this type. The server keeps a value to one row of the type in every state, answers `409 link_taken` to a write giving a second row a value another holds, and records the value as a tombstone when the row is purged. It applies to rows of exactly this type: a subtype names its own. The field's name holds neither a double quote nor a backslash.",
  );

const VersionPolicySchema = z
  .looseObject({
    recent_days: z.number().optional(),
    daily_snapshot_days: z.number().optional(),
    weekly_snapshot_days: z.number().optional(),
    max_versions: z.number().optional(),
  })
  .openapi("VersionPolicy");

/**
 * A type as the two authoring doors take it.
 *
 * The objects are loose, so a key the declaration does not name reaches the
 * validator as it was sent, and `refuseAsTheValidatorWould` answers the
 * shape check with this door's codes rather than a generic one.
 *
 * The declaration is the tighter of the two on three axes the validator
 * leaves to normalization: a `description`, a `required` flag or an
 * `items_type` of the wrong type is refused here where the validator
 * dropped the value and carried on. That is the point of declaring a shape
 * a client builds from — a value silently discarded is a field the caller
 * believes it set.
 */
const typeDefinitionBody = {
  fields: z.record(z.string(), FieldDefinitionSchema),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Omit it to default to 1. A replacement carries the version it moves to.",
    ),
  parent: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  // Strings rather than the role enum the response carries, because the
  // validator is the one that refuses an unknown role and it names `roles`
  // where a declared enum would name the entry. The vocabulary is closed
  // all the same; what changes is only which check answers.
  roles: z
    .array(z.string())
    .optional()
    .describe(
      `Structural roles this type plays, drawn from the closed vocabulary ${TYPE_ROLES.join(", ")}. An entry outside it is refused \`400 invalid_schema\` naming \`roles\`.`,
    ),
  required: z
    .array(z.string())
    .optional()
    .describe(
      "Field names this type requires, the alternative to `required: true` on each field. Both forms are taken and mean the same thing.",
    ),
  // A bare string as well as a list: the validator takes both, so a
  // declaration that took only the list would refuse a body the server
  // accepts.
  compatible_with: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Sibling types this one asserts a structural superset of. A bare string names one.",
    ),
  display_hints: DisplayHintsSchema.optional(),
  link_field: LinkFieldSchema.optional(),
  version_policy: VersionPolicySchema.optional(),
  merge_policy: MergePolicySchema.optional(),
};

// `fields` leads the shape, and `id` follows it, because a refusal names
// the first field the body does not carry and this door's canonical
// refusal in `errors.md` is a body with no `fields`.
const TypeDefinitionInputSchema = z
  .looseObject({ ...typeDefinitionBody, id: z.string() })
  .openapi("TypeDefinitionInput");

/**
 * The same body on the replacement door, where the path names the type.
 *
 * No `id`: the handler composes the schema from the path's identifier, and a
 * body carrying one has never moved anything. Declaring it would refuse a
 * body the door accepts, since a loose object passes an undeclared key
 * through untouched.
 */
const TypeDefinitionUpdateSchema = z
  .looseObject(typeDefinitionBody)
  .openapi("TypeDefinitionUpdate");

/**
 * Refuse a body the declaration rejects the way the validator would have.
 *
 * These two doors answer `missing_required_field` for a field the body does
 * not carry and `invalid_schema` for everything else they cannot read, and
 * the chapters name both. A declared body is checked before the handler is
 * reached, so without this the shape check would answer
 * `validation_error` instead: the same request, the same status, a
 * different code.
 */
const refuseAsTheValidatorWould = (
  result: { success: true } | { success: false; error: z.ZodError },
): undefined => {
  if (result.success) return;
  // `fields` alone answers `missing_required_field`, which is this door's
  // answer for a body that does not carry it — `null` included, since a
  // `null` fields block carries no fields. Every other absence is
  // `invalid_schema`, as it was when the validator saw these bodies first.
  const missingFields = result.error.issues.some(
    (issue) =>
      issue.code === "invalid_type" &&
      issue.path.length === 1 &&
      issue.path[0] === "fields" &&
      (issue.message.includes("received undefined") ||
        issue.message.includes("received null")),
  );
  if (missingFields) {
    throw new MarfaError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      "fields is required",
      { field: "fields" },
    );
  }
  // `errors` names the position, what was expected there and what arrived,
  // as the validator's own issues do. Two of its keys are absent and cannot
  // be produced here: `hint`, which the validator can write because it knows
  // what the field is for, and `code`, which discriminates refusals like
  // `property_shadows_field` that only the validator can reach.
  throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid type schema", {
    errors: result.error.issues.map((issue) => ({
      field: issue.path.length === 0 ? "_root" : issue.path.join("."),
      expected: "expected" in issue ? issue.expected : undefined,
      actual: "received" in issue ? issue.received : undefined,
      message: issue.message,
    })),
  });
};

const TypeSchemaResponse = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    parent: z.string().optional(),
    // Clients resolve a sibling type's read-as relationship from this field,
    // so it must reach the generated spec — an omission here strips it from
    // every generated client even though the runtime body carries it.
    compatible_with: z.array(z.string()).optional(),
    // Edges constrain on roles, so a client deciding whether an item may be
    // pointed at a container reads this. Omitting it from the spec would strip
    // it from every generated client while the runtime kept returning it.
    roles: z.array(z.enum(TYPE_ROLES).openapi("TypeRole")).optional(),
    fields: z.record(z.string(), z.unknown()),
    version: z.number(),
    display_hints: DisplayHintsSchema.optional(),
    link_field: LinkFieldSchema.optional(),
    version_policy: VersionPolicySchema.optional(),
    merge_policy: MergePolicySchema.optional(),
  })
  .openapi("TypeDefinition");

const TypeResponseSchema = z
  .object({ type: TypeSchemaResponse })
  .openapi("TypeResponse");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTypesRoute = createRoute({
  operationId: "listTypes",
  method: "get",
  path: "/",
  tags: ["Types"],
  summary: "List types",
  description:
    "Returns every type this instance resolves: the catalog this build ships, everything registered through `POST /types`, and any platform row an earlier build seeded that this one no longer ships. That third group is drift rather than vocabulary — a type retired by a rename survives on an instance upgraded across it, and keeps resolving and listing here until an operator retires the row. `GET /admin/platform-types/drift` names them and `DELETE /admin/platform-types/{id}` removes one. Use as the schema manifest a type-aware client reads at startup.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(TypeSchemaResponse, "TypeDefinitionPage"),
        },
      },
      description: "List of all type schemas",
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

const getTypeRoute = createRoute({
  operationId: "getType",
  method: "get",
  path: "/{id}",
  tags: ["Types"],
  summary: "Get a type",
  description:
    "Returns the full schema for a single type, resolving inheritance so the response reflects the effective fields and policies. Works for a platform-shipped type and one registered on this instance alike.\n\nA type whose stored inheritance chain cannot be resolved — circular, or deeper than any resolution walk follows — answers `409 type_chain_unresolvable` rather than a server fault. Correcting it through `PUT /types/{id}` still works, because that route reads the stored schema directly instead of resolving it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: TypeSchemaResponse,
        },
      },
      description: "Type schema",
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
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "Type not found",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_chain_unresolvable"]),
        },
      },
      description: "Stored inheritance chain cannot be resolved",
    },
  },
});

const registerTypeRoute = createRoute({
  operationId: "registerType",
  method: "post",
  path: "/",
  middleware: [
    (c: Context<AppEnv>, next: Next) => {
      requireMetadataPermission(c, "types", "write");
      return next();
    },
  ] as const,
  tags: ["Types"],
  summary: "Register a type",
  description:
    "Registers a type at runtime under the `app.*`, `user.*`, or `<publisher>.*` namespaces; a reserved root rejects with `403 forbidden`, and ancestor-field redefinitions and property names shadowing first-class `Item` fields reject with `400`, as does a `link_field` naming anything but a string field the type declares or inherits, or one whose name holds a double quote or a backslash (`invalid_schema`). A type registered under an identifier starts with no tombstones, even those the purge of a row a forced delete left under it recorded. Every credential needs the `metadata.types:write` scope, which is off by default. The operator key is no exception: this door reads the map like any other.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: TypeDefinitionInputSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: TypeResponseSchema,
        },
      },
      description: "Type registered",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "inheritance_violation",
            "invalid_schema",
            "missing_required_field",
            "property_shadows_field",
            "validation_error",
          ]),
        },
      },
      description:
        "`missing_required_field` when the body carries no `fields`; `invalid_schema` for any other shape the validator refuses; `validation_error` for a malformed identifier; `property_shadows_field` for a field name a first-class `Item` field already holds; `inheritance_violation` for a child changing a field it inherits.",
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
      description:
        "Missing metadata.types:write permission, or a reserved namespace: `core.*`, `system.*` and `marfa.*` are refused to every credential",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "type_already_exists",
            "link_taken",
          ]),
        },
      },
      description:
        "`type_already_exists`: the identifier is registered. `link_taken`: the type names a `link_field`, and two rows a forced delete left under the identifier hold the same value there; neither row is named.",
    },
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["compatible_with_violation"]),
        },
      },
      description:
        "`compatible_with` names a type this instance does not hold, or one whose shape the declaring type does not satisfy.",
    },
  },
});

const updateTypeRoute = createRoute({
  operationId: "updateType",
  method: "put",
  path: "/{id}",
  middleware: [
    (c: Context<AppEnv>, next: Next) => {
      requireAuth(c);
      requirePermission(c, "schema.write");
      // The path parameter, before the route's own validator has run: the
      // router matched this route on it, so it is present.
      const id = c.req.param("id") ?? "";
      if (!isValidTypeIdentifier(id)) {
        throw malformedTypeIdentifier("id", `Invalid type identifier: ${id}`);
      }
      if (isLockedPlatformType(id)) {
        throw new MarfaError(
          ErrorCode.CORE_TYPE_IMMUTABLE,
          `Cannot modify platform-shipped types`,
        );
      }
      if (!getTypeSchema(id)) {
        throw new MarfaError(
          ErrorCode.TYPE_NOT_FOUND,
          `Type "${id}" not found`,
        );
      }
      return next();
    },
  ] as const,
  tags: ["Types"],
  summary: "Update a registered type",
  description:
    "Replaces a registered type's schema, re-running the registration-time correctness rails. Requires `schema.write` — core types are immutable and return 403; the structural diff between versions sets the required version bump, and a mismatch rejects with `422 version_bump_mismatch`. Naming, changing or withdrawing a `link_field` is a change that needs one, and the type's rows in every state are held to the new link at once: two holding one value refuse the replacement `409 link_taken`. The old link's tombstones go with it, since they hold another field's values. A change that would leave a type inheriting from this one linking by a field it no longer declares or inherits, or by one no longer a string, is refused `400 invalid_schema`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
    }),
    body: {
      content: {
        "application/json": {
          schema: TypeDefinitionUpdateSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: TypeResponseSchema,
        },
      },
      description: "Type updated",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "inheritance_violation",
            "invalid_schema",
            "validation_error",
          ]),
        },
      },
      description:
        "`validation_error` for a malformed identifier, a body of the wrong shape, or a parent chain that is circular, too deep or unresolved; `inheritance_violation` for a field whose shape differs from the one a type above or below it in the chain declares under the same name; `invalid_schema` for any other schema the validator refuses.",
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
          schema: makeErrorResponseSchema(["forbidden", "core_type_immutable"]),
        },
      },
      description:
        "`forbidden`: the credential does not hold `schema.write`. `core_type_immutable`: the identifier names a platform-shipped type, which no credential may replace.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "Type not found",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["link_taken"]),
        },
      },
      description:
        "The replacement names a `link_field` two of the type's rows, in any state, hold the same value in. Neither row is named: the door does not ask whether the caller may read them.",
    },
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["version_bump_mismatch"]),
        },
      },
      description:
        "The submitted `version` does not move as the change requires: a resubmission that changes nothing still has to name the version it replaces.",
    },
  },
});

const deleteTypeRoute = createRoute({
  operationId: "deleteType",
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a registered type",
  description:
    "Removes a type registration. Requires `schema.write` — platform-shipped types are immutable.\n\nRejected with `409 type_has_subtypes` while another registered type declares this one as its parent, naming them in `details.subtype_ids`. `?force=true` does not cover that case: delete each subtype first, or give it a different parent through `PUT /types/{id}`.\n\nRejected with `409 type_in_use` if any item of the type still exists in any lifecycle state, the bin included, unless `?force=true` orphans those rows (they persist, but new writes against the type return `400 unknown_type`).\n\nThe tombstones purges left under the type go with it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
    }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Delete and orphan existing items when `true`. Has no effect on the subtype check.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Type deleted",
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
          schema: makeErrorResponseSchema(["forbidden", "core_type_immutable"]),
        },
      },
      description:
        "`forbidden`: the credential does not hold `schema.write`. `core_type_immutable`: the identifier names a platform-shipped type, which no credential may remove.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "Type not found",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_in_use", "type_has_subtypes"]),
        },
      },
      description: "Type still has subtypes, or items",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function typeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTypesRoute, (c) => {
    requireAuth(c);
    const resolve: TypeResolver = (id) => getTypeSchema(id);
    // Schemas come back as declared, not resolved, which is deliberate:
    // resolving fields and policies for every type in a vocabulary is work a
    // caller who wants one type should pay per type. `roles` is the exception
    // and has to be, because a role exists to be enumerated. A client asking
    // "which of these can hold a collection" reads this list, and answering
    // with declared roles omits every subtype of a container while the write
    // path accepts them. Same helper as the single read, so the two cannot
    // give different answers about the same type.
    return c.json(
      {
        data: listTypes().map((schema) => {
          const roles = resolveRoles(schema.id, resolve);
          return roles ? { ...schema, roles } : schema;
        }),
        next_cursor: null,
      },
      200,
    );
  });

  router.openapi(getTypeRoute, (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const schema = resolveTypeSchema(id, (typeId) => getTypeSchema(typeId));
    if (!schema) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    return c.json(schema, 200);
  });

  router.openapi(
    registerTypeRoute,
    async (c) => {
      const body = c.req.valid("json");

      if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
        throw malformedTypeIdentifier(
          "id",
          "Invalid type identifier. Must follow the five-tier namespace grammar: core.<type>, system.<type>, app.<app-name>.<type>, user.<type>, or <publisher>.<type>. Forward slashes and reserved-root collisions are rejected.",
        );
      }
      // Reserved namespaces are a property of the build, not of the request.
      // `core.*` and `system.*` are authored as JSON in the type package and
      // compiled into the registry, and `marfa.*` is held for the platform;
      // nothing legitimate mints one over HTTP, and the route's own published
      // description already says so.
      //
      // No credential is excepted, the operator key included, because a
      // restore refuses a reserved-namespace type whatever credential it
      // runs under: a door that admitted one would put a row in the exports
      // that its own restore then refuses, taking the archive with it.
      if (typeof body.id === "string") {
        const tier = classifyNamespace(body.id);
        if (tier === "core" || tier === "system" || tier === "marfa") {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `Reserved namespace: ${tier}.* types are platform-shipped and cannot be registered at runtime`,
            { namespace: tier },
          );
        }
      }
      const result = validateTypeSchema(body);
      if (!result.success) {
        // Surface specific error codes so clients can disambiguate from generic schema failures.
        const hasPropertyShadowsField = result.errors.some(
          (e) => e.code === "property_shadows_field",
        );
        const hasInheritanceViolation = result.errors.some(
          (e) => e.code === "inheritance_violation",
        );
        const hasCompatibleWithViolation = result.errors.some(
          (e) => e.code === "compatible_with_violation",
        );
        let code: ErrorCode;
        let message: string;
        if (hasPropertyShadowsField) {
          code = ErrorCode.PROPERTY_SHADOWS_FIELD;
          message =
            "Type schema declares a property whose name shadows a first-class Item field";
        } else if (hasInheritanceViolation) {
          code = ErrorCode.INHERITANCE_VIOLATION;
          message = "Child type redefines a field declared by an ancestor";
        } else if (hasCompatibleWithViolation) {
          code = ErrorCode.COMPATIBLE_WITH_VIOLATION;
          message =
            "Type does not satisfy the structural-superset of its compatible_with target";
        } else {
          code = ErrorCode.INVALID_SCHEMA;
          message = "Invalid type schema";
        }
        throw new MarfaError(code, message, { errors: result.errors });
      }

      const schema = result.data;

      if (!schema.label) {
        const lastSegment = schema.id.split(".").pop() ?? schema.id;
        schema.label = lastSegment
          .replace(/[_-]/g, " ")
          .replace(/\b\w/g, (ch) => ch.toUpperCase());
      }

      if (schema.parent) {
        validateParentChain(schema.id, schema.parent);
      }

      if (getTypeSchema(schema.id)) {
        throw new MarfaError(
          ErrorCode.TYPE_ALREADY_EXISTS,
          `Type "${schema.id}" already exists`,
        );
      }

      const created = await storage.types.create(schema);
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "type.register",
        resource_type: "type",
        resource_id: schema.id,
      });
      return c.json({ type: created }, 201);
    },
    refuseAsTheValidatorWould,
  );

  router.openapi(
    updateTypeRoute,
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = getTypeSchema(id);
      // The route's middleware refuses every reason the row could be
      // missing before the body is read, so this is unreachable; it is here
      // because the registry's lookup cannot say that, and a cast would
      // hand the handler an undefined the moment it stops being true.
      if (!existing) {
        throw new MarfaError(
          ErrorCode.TYPE_NOT_FOUND,
          `Type "${id}" not found`,
        );
      }

      const body = c.req.valid("json");
      const result = validateTypeSchema({ ...body, id });
      if (!result.success) {
        // The inheritance rule is one rule from either end of the chain,
        // so this door answers it with the code registration does.
        if (result.errors.some((e) => e.code === "inheritance_violation")) {
          throw new MarfaError(
            ErrorCode.INHERITANCE_VIOLATION,
            "Type gives a field a shape another type in its chain declares differently",
            { errors: result.errors },
          );
        }
        throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid type schema", {
          errors: result.errors,
        });
      }

      const schema = result.data;

      if (schema.parent) {
        // Measured on the type as it stands, before the update lands, which is
        // the subtree that would move with it.
        validateParentChain(
          schema.id,
          schema.parent,
          maxDescendantDepth(schema.id),
        );
      }

      // Server-side semver diff via a structural classifier: no-op
      // submissions are rejected, descriptive-only changes accept the existing
      // version, additive and breaking changes require an explicit bump. The
      // classifier returns the diff class for telemetry and error messages.
      const diff = diffTypeSchemas(existing, schema);
      if (diff === "noop") {
        throw new MarfaError(
          ErrorCode.VERSION_BUMP_MISMATCH,
          "No structural or descriptive changes — re-submitting an identical schema is rejected",
          { diff },
        );
      }
      // A major diff (field removal) is permitted; the version-bump check below enforces
      // that the caller explicitly incremented the version, and the diff class surfaces
      // in audit.
      if (!isValidVersionBump(diff, existing.version, schema.version)) {
        throw new MarfaError(
          ErrorCode.VERSION_BUMP_MISMATCH,
          diff === "patch"
            ? "Descriptive-only change accepts the existing version or higher"
            : `${diff[0]?.toUpperCase() ?? ""}${diff.slice(1)} change requires version > ${String(existing.version)}`,
          { diff, existing_version: existing.version },
        );
      }

      const updated = await storage.types.update(id, schema);
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "type.update",
        resource_type: "type",
        resource_id: id,
      });
      return c.json({ type: updated }, 200);
    },
    refuseAsTheValidatorWould,
  );

  router.openapi(deleteTypeRoute, async (c) => {
    requireAuth(c);
    requirePermission(c, "schema.write");
    const { id } = c.req.valid("param");

    if (isLockedPlatformType(id)) {
      throw new MarfaError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot delete platform-shipped types`,
      );
    }

    const existing = getTypeSchema(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }

    // Checked before the items refusal, and outside `force`, because this
    // one cannot be forced past. Reporting the forcible obstruction first
    // would send a caller round again to meet the one that stops them.
    //
    // Refusing rather than repairing the children is the deliberate choice.
    // A child that inherits IS its parent: `isSubtypeOf` answers yes and a
    // subtree query finds its items. Flattening the inherited fields down
    // would keep the field names and lose that, changing the child's meaning
    // as a side effect of a command naming a different type, and it would
    // have to either bypass or silently satisfy the version bump that
    // `PUT /types/:id` requires for a parent change.
    const subtypes = directChildrenOf(id);
    if (subtypes.length > 0) {
      throw new MarfaError(
        ErrorCode.TYPE_HAS_SUBTYPES,
        `Type "${id}" cannot be deleted while ${subtypes
          .map((subtype) => `"${subtype}"`)
          .join(
            ", ",
          )} ${subtypes.length === 1 ? "inherits" : "inherit"} from it. Delete ${subtypes.length === 1 ? "it" : "them"} first, or give ${subtypes.length === 1 ? "it" : "each"} a different parent with PUT /types/{id}. This is not what ?force=true covers, which is existing items.`,
        { subtype_ids: subtypes },
      );
    }

    const { force } = c.req.valid("query");
    if (force !== "true") {
      const items = await storage.items.list({
        type: id,
        // Every state, because the question is whether anything is written
        // against this type, not whether anything is being worked on. A row
        // in the bin or the archive still names the type it was validated
        // against, and deleting it out from under one leaves a row whose
        // shape nothing can check.
        all_states: true,
        limit: 1,
      });
      if (items.data.length > 0) {
        throw new MarfaError(
          ErrorCode.TYPE_IN_USE,
          `Type "${id}" has existing items. Use ?force=true to delete anyway.`,
        );
      }
    }

    await storage.types.delete(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "type.delete",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
