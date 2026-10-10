import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  getTypeSchema,
  directChildrenOf,
  maxDescendantDepth,
  listTypes,
  validateTypeSchema,
  isValidTypeIdentifier,
  classifyNamespace,
  TYPE_ROLES,
  FIELD_TYPES,
  FIELD_FORMATS,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { SchemaValidationIssue } from "@withmarfa/shared";
import type { Context, Next } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { resolveRoles, resolveTypeSchema } from "../storage/policy.js";
import type { TypeResolver } from "../storage/policy.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import { assertParentChain } from "./_parent-chain.js";
import {
  changesSchema,
  isLockedPlatformType,
  registersType,
  replacesType,
  requireParentReach,
  requireTypeReplacement,
  requireTypeSchemaWrite,
} from "./_schema-reach.js";
import { MergePolicySchema, wholeListOf } from "./_schemas.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

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
        "The field's type. A `thumbnail` holds an image of at most 16 KiB, as a base64 `data:` URI of type `image/png`, `image/jpeg` or `image/webp`. A type has at most one, never as an array's `items_type` or under `title`, `body`, `description` or `name`.",
      ),
    description: z.string().optional().describe("What the field holds."),
    required: z
      .boolean()
      .optional()
      .describe("`true` if an item of the type must have a value for it."),
    enum_values: z
      .array(z.string())
      .optional()
      .describe("The values an `enum` field allows."),
    items_type: z
      .string()
      .optional()
      .describe("The type of each element of an `array` field."),
    format: z
      .enum(FIELD_FORMATS as unknown as [string, ...string[]])
      .optional()
      .describe(
        "A refinement of a `string` field, or of an array of strings. `url`, `email`, `datetime`, `date` and `thumbnail` become the field's `type`, and all but `thumbnail` an array's `items_type`. `bcp47` and `iso3166` stay as `format`.",
      ),
    searchable: z
      .boolean()
      .optional()
      .describe(
        "`false` if full-text search should skip the field. Items still return it.",
      ),
    maxLength: z
      .number()
      .int()
      .optional()
      .describe("The longest value a `string` or `enum` field allows."),
    maxItems: z
      .number()
      .int()
      .optional()
      .describe("The most elements an `array` field allows."),
  })
  .describe("One field of a type: its type, and how items may fill it.")
  .openapi("FieldDefinition");

const DisplayHintsSchema = z
  .looseObject({
    title_field: z
      .string()
      .optional()
      .describe("The field that holds an item's title for display."),
    body_field: z
      .string()
      .optional()
      .describe("The field that holds an item's body for display."),
  })
  .describe("Which fields of a type clients show as an item's title and body.")
  .openapi("DisplayHints");

const MERGE_POLICY = "How Marfa merges conflicting edits to the type's items.";
const DISPLAY_HINTS = "Which fields clients show as an item's title and body.";
const VERSION_POLICY = "How long Marfa keeps the versions of the type's items.";
const COMPATIBLE_WITH = "The types this one is a structural superset of.";

const LinkFieldSchema = z
  .string()
  .describe(
    "The name of a string field, declared or inherited, that holds each item's own ID at the vendor that writes the type. No two items of the type, in any state, hold the same value. A subtype names its own link. The name has no `\"` or `\\`.",
  );

const VersionPolicySchema = z
  .looseObject({
    recent_days: z
      .number()
      .optional()
      .describe(
        "How many days back Marfa keeps every version of an item. Counts from now.",
      ),
    daily_snapshot_days: z
      .number()
      .optional()
      .describe(
        "How many days back Marfa keeps one version per day, after the recent window.",
      ),
    weekly_snapshot_days: z
      .number()
      .optional()
      .describe(
        "How many days back Marfa keeps one version per week, after the daily window. Marfa deletes older versions, but always keeps the latest.",
      ),
    max_versions: z
      .number()
      .optional()
      .describe(
        "The most versions Marfa keeps for an item. Past it, Marfa drops the oldest first.",
      ),
  })
  .describe(
    "How long Marfa keeps the versions of a type's items. A field you leave out comes from the parent type, then from the instance defaults.",
  )
  .openapi("VersionPolicy");

/** This module's part of `DESCRIBED_ONLY_BY_REFERENCE` in `_schemas.ts`. */
export const TYPE_SCHEMAS_DESCRIBED_BY_REFERENCE: Readonly<
  Record<string, z.ZodType>
> = {
  DisplayHints: DisplayHintsSchema,
  VersionPolicy: VersionPolicySchema,
};

/**
 * A type as the two authoring doors take it.
 *
 * The objects are loose, so a key the declaration does not name reaches the
 * validator as it was sent, which refuses it as `invalid_schema` naming its
 * path. A strict object would strip the key instead and register the type
 * without it. `refuseAsTheValidatorWould` answers the shape check with this
 * door's codes rather than a generic one.
 *
 * The declaration is the tighter of the two on three axes the validator
 * leaves to normalization: a `description`, a `required` flag or an
 * `items_type` of the wrong type is refused here where the validator
 * dropped the value and carried on. That is the point of declaring a shape
 * a client builds from — a value silently discarded is a field the caller
 * believes it set.
 */
const typeDefinitionBody = {
  fields: z
    .record(z.string(), FieldDefinitionSchema)
    .describe("The type's own fields, by name."),
  version: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "A number for you to track changes to the type. Marfa never changes it. Leave it out for 0.",
    ),
  parent: z
    .string()
    .optional()
    .describe(
      "The identifier of the type this one inherits from. To set or change it, you need write on it, unless Marfa ships it. Leave it out for a type with no parent.",
    ),
  label: z
    .string()
    .optional()
    .describe(
      "A name for people to read. Leave it out and Marfa derives one from the last segment of the identifier.",
    ),
  description: z.string().optional().describe("What the type is for."),
  // Strings rather than the role enum the response carries, because the
  // validator is the one that refuses an unknown role and it names `roles`
  // where a declared enum would name the entry. The vocabulary is closed
  // all the same; what changes is only which check answers.
  roles: z
    .array(z.string())
    .optional()
    .describe(
      `The structural roles the type plays: ${TYPE_ROLES.map((role) => `\`${role}\``).join(", ")}. An edge type's \`role:<name>\` constraint matches types by role.`,
    ),
  required: z
    .array(z.string())
    .optional()
    .describe(
      "The names of the fields an item of the type must have. It means the same as `required: true` on each of them.",
    ),
  // A bare string as well as a list: the validator takes both, so a
  // declaration that took only the list would refuse a body the server
  // accepts.
  compatible_with: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      `${COMPATIBLE_WITH} Marfa checks the claim when you save the type. A bare string names one type.`,
    ),
  display_hints: DisplayHintsSchema.optional().describe(DISPLAY_HINTS),
  link_field: LinkFieldSchema.optional(),
  version_policy: VersionPolicySchema.optional().describe(VERSION_POLICY),
  merge_policy: MergePolicySchema.optional().describe(MERGE_POLICY),
};

// `fields` leads the shape, and `id` follows it, because a refusal names
// the first field the body does not carry and this door's canonical
// refusal in `errors.md` is a body with no `fields`.
const TypeDefinitionInputSchema = z
  .looseObject({
    ...typeDefinitionBody,
    id: z
      .string()
      .describe("The type's identifier, such as `acme.deal` or `user.recipe`."),
  })
  .describe("A type to register.")
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
  .describe("The schema that replaces a type's stored one.")
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

/** Gives a schema naming no label one made from its identifier's last segment. */
function labelled<T extends { id: string; label?: string }>(schema: T): T {
  if (!schema.label) {
    const lastSegment = schema.id.split(".").pop() ?? schema.id;
    schema.label = lastSegment
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return schema;
}

/** The refusal both authoring doors give a schema the validator refused. */
function schemaRefusal(errors: SchemaValidationIssue[]): MarfaError {
  const has = (code: string) => errors.some((e) => e.code === code);
  if (has("property_shadows_field")) {
    return new MarfaError(
      ErrorCode.PROPERTY_SHADOWS_FIELD,
      "Type schema declares a property whose name shadows a first-class Item field",
      { errors },
    );
  }
  if (has("inheritance_violation")) {
    return new MarfaError(
      ErrorCode.INHERITANCE_VIOLATION,
      "Type gives a field a shape another type in its chain declares differently",
      { errors },
    );
  }
  if (has("compatible_with_violation")) {
    return new MarfaError(
      ErrorCode.COMPATIBLE_WITH_VIOLATION,
      "Type does not satisfy the structural-superset of its compatible_with target",
      { errors },
    );
  }
  return new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid type schema", {
    errors,
  });
}

const TypeSchemaResponse = z
  .object({
    id: z.string().describe("Unique identifier for the type."),
    label: z
      .string()
      .optional()
      .describe("The type's name for people to read."),
    description: z.string().optional().describe("What the type is for."),
    parent: z
      .string()
      .optional()
      .describe("The identifier of the type this one inherits from."),
    // Clients resolve a sibling type's read-as relationship from this field,
    // so it must reach the generated spec — an omission here strips it from
    // every generated client even though the runtime body carries it.
    compatible_with: z.array(z.string()).optional().describe(COMPATIBLE_WITH),
    // Edges constrain on roles, so a client deciding whether an item may be
    // pointed at a container reads this. Omitting it from the spec would strip
    // it from every generated client while the runtime kept returning it.
    roles: z
      .array(
        z
          .enum(TYPE_ROLES)
          .describe(
            "A structural role a type plays. `container`: the type can be the target of an `in-collection` edge.",
          )
          .openapi("TypeRole"),
      )
      .optional()
      .describe(
        "The structural roles the type plays, including those it inherits.",
      ),
    fields: z
      .record(z.string(), FieldDefinitionSchema)
      .describe(
        "The type's own fields, by name. `GET /types/{id}` adds the fields it inherits.",
      ),
    version: z
      .number()
      .describe("The version number the type was last saved with."),
    display_hints: DisplayHintsSchema.optional().describe(DISPLAY_HINTS),
    link_field: LinkFieldSchema.optional(),
    version_policy: VersionPolicySchema.optional().describe(VERSION_POLICY),
    merge_policy: MergePolicySchema.optional().describe(MERGE_POLICY),
  })
  .describe(
    "A type says which fields the items of that type hold, and what else Marfa does for them.",
  )
  .openapi("TypeDefinition");

const TypeResponseSchema = z
  .object({ type: TypeSchemaResponse.describe("The type.") })
  .describe("One type.")
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
    "Returns every type on this instance: those Marfa ships and those registered through `POST /types`. Every credential reads the whole list, whatever its type map reaches.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(TypeSchemaResponse, "TypeDefinitionPage", "type"),
        },
      },
      description:
        "Returns every type. A type lists only its own fields, so resolve the rest through `parent`.",
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
    "Returns a type's schema, with the fields and policies it inherits from its ancestors. Every credential reads any type, whatever its type map reaches.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z
        .string()
        .describe("The identifier of the type, such as `core.note`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: TypeSchemaResponse,
        },
      },
      description: "Returns the type.",
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
      description: "`type_not_found`: no type has this identifier.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_chain_unresolvable"]),
        },
      },
      description:
        "`type_chain_unresolvable`: the type's parent chain is circular or too deep to resolve. `PUT /types/{id}` can correct it.",
    },
  },
});

const registerTypeRoute = createRoute({
  operationId: "registerType",
  method: "post",
  path: "/",
  middleware: registersType,
  tags: ["Types"],
  summary: "Register a type",
  description:
    "Registers a type under the `app.*`, `user.*` or `<publisher>.*` namespace and returns it. Name a `parent` to inherit its fields.",
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
      description: "Returns the new type.",
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
        "- `missing_required_field`: `fields` is missing.\n- `validation_error`: `id` is malformed, or `parent` isn't registered or makes too deep a chain.\n- `invalid_schema`: the schema is invalid, such as a `link_field` that isn't a string field, or a key the schema doesn't define, such as `minimum` on a field (`details.errors` names each key's path).\n- `property_shadows_field`: a field is named like one every item has, such as `source_id`.\n- `inheritance_violation`: the type reshapes an inherited field.",
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
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "- `forbidden`: you don't have `metadata.types:write`, or the identifier is under `core.*`, `system.*` or `marfa.*`, which no credential can register.\n- `type_not_permitted`: your type map doesn't grant write on the identifier, or on `parent` (`details.grant` names it).",
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
        "- `type_already_exists`: a type has this identifier.\n- `link_taken`: two items that a forced delete left under this identifier hold the same value in the `link_field`.",
    },
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["compatible_with_violation"]),
        },
      },
      description:
        "`compatible_with_violation`: `compatible_with` names a type this instance doesn't hold, or one the type doesn't satisfy.",
    },
  },
});

const replaceTypeRoute = createRoute({
  operationId: "replaceType",
  method: "put",
  path: "/{id}",
  middleware: [
    replacesType,
    (c: Context<AppEnv>, next: Next) => {
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
      requireTypeSchemaWrite(c, "replace", id);
      return next();
    },
  ] as const,
  tags: ["Types"],
  summary: "Replace a type",
  description:
    "Replaces a registered type's whole schema and returns it. A field you leave out is removed, but items keep their values for it. `metadata.types:write` alone can add optional fields and change `label`, `description`, `display_hints` or `version`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z
        .string()
        .describe("The identifier of the type, such as `acme.deal`."),
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
      description: "Returns the replaced type.",
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
        "- `missing_required_field`: `fields` is missing.\n- `validation_error`: `id` is malformed, or `parent` isn't registered or makes a circular or too deep chain.\n- `invalid_schema`: the schema is invalid, such as a `link_field` that isn't a string field, or a key the schema doesn't define, such as `minimum` on a field (`details.errors` names each key's path).\n- `property_shadows_field`: a field has the name of one every item has.\n- `inheritance_violation`: a field's shape differs in a parent or subtype.",
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
          schema: makeErrorResponseSchema([
            "forbidden",
            "core_type_immutable",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `forbidden`: you have neither `schema.write` nor `metadata.types:write`, or the change needs `schema.write`, such as adding a field some item already holds a value under. `details.changes` lists what needs it.\n- `core_type_immutable`: Marfa ships this type.\n- `type_not_permitted`: your type map doesn't grant write on the type or a new `parent` (`details.grant` names it).",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "`type_not_found`: no type has this identifier.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["link_taken"]),
        },
      },
      description:
        "`link_taken`: the replacement names a `link_field` in which two items of the type, in any state, hold the same value.",
    },
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["compatible_with_violation"]),
        },
      },
      description:
        "`compatible_with_violation`: `compatible_with` names a type this instance doesn't hold, or one the type doesn't satisfy.",
    },
  },
});

const deleteTypeRoute = createRoute({
  operationId: "deleteType",
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a type",
  description:
    "Deletes a type. With `force=true`, items of the type stay, but writes that create them or set their properties fail with `unknown_type` until the type is registered again.",
  security: [{ bearerAuth: [] }],
  middleware: changesSchema,
  request: {
    params: z.object({
      id: z
        .string()
        .describe("The identifier of the type, such as `acme.deal`."),
    }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Delete the type even if items of it exist, in any state. It doesn't cover a type that has subtypes.",
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
      description: "Returns `ok: true`.",
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
          schema: makeErrorResponseSchema([
            "forbidden",
            "core_type_immutable",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `forbidden`: you don't have `schema.write`.\n- `core_type_immutable`: Marfa ships this type, and no credential can delete it.\n- `type_not_permitted`: your type map doesn't grant write on the type.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "`type_not_found`: no type has this identifier.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_in_use", "type_has_subtypes"]),
        },
      },
      description:
        "- `type_has_subtypes`: other types name this one as their `parent` (`details.subtype_ids` lists them). Delete them, or give them another parent with `PUT /types/{id}`.\n- `type_in_use`: an item of the type exists, in any state, and `force` isn't `true`.",
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
      // No caller is excepted, because a
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
        // Asked whether or not the id is held, so one key cannot take an id
        // first and leave the key it was meant for unable to register it.
        requireTypeSchemaWrite(c, "register", body.id);
      }
      // Validated in the transaction that writes the type: the schema is
      // judged against its parent's fields and its parent chain, and a
      // parent changed or deleted meanwhile has to be the one it is judged
      // against. A delete waiting on this write finds the child and is
      // refused instead.
      const created = await runAuditedTransaction(
        storage,
        async () => {
          const result = validateTypeSchema(body);
          if (!result.success) {
            throw schemaRefusal(result.errors);
          }

          const schema = result.data;

          labelled(schema);

          if (schema.parent) {
            requireParentReach(c, schema.parent);
            validateParentChain(schema.id, schema.parent);
          }
          if (getTypeSchema(schema.id)) {
            throw new MarfaError(
              ErrorCode.TYPE_ALREADY_EXISTS,
              `Type "${schema.id}" already exists`,
            );
          }
          return await storage.types.create(schema);
        },
        (created) => ({
          client_ip: c.get("clientIp") ?? null,
          key_id: c.get("apiKey")?.id,
          action: "type.register",
          resource_type: "type",
          resource_id: created.id,
        }),
      );

      return c.json({ type: created }, 201);
    },
    refuseAsTheValidatorWould,
  );

  router.openapi(
    replaceTypeRoute,
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      // Everything the replacement is judged by is read in the transaction
      // that writes it: whether the type still exists, its parent chain, and
      // the subtypes whose fields a new field may not clash with. Each can
      // be changed by another write, and one checked before the lock is a
      // check of a registry that may have moved by the time the row does.
      const updated = await runAuditedTransaction(
        storage,
        async () => {
          const stored = getTypeSchema(id);
          if (!stored) {
            throw new MarfaError(
              ErrorCode.TYPE_NOT_FOUND,
              `Type "${id}" not found`,
            );
          }
          const result = validateTypeSchema({ ...body, id });
          if (!result.success) {
            throw schemaRefusal(result.errors);
          }

          const schema = labelled(result.data);
          await requireTypeReplacement(c, stored, schema, (types, names) =>
            storage.types.propertyNamesHeld(types, names),
          );
          if (schema.parent) {
            // Measured on the type as it stands, before the update lands, which
            // is the subtree that would move with it.
            validateParentChain(
              schema.id,
              schema.parent,
              maxDescendantDepth(schema.id),
            );
          }
          return await storage.types.update(id, schema);
        },
        {
          client_ip: c.get("clientIp") ?? null,
          key_id: c.get("apiKey")?.id,
          action: "type.replace",
          resource_type: "type",
          resource_id: id,
        },
      );

      return c.json({ type: updated }, 200);
    },
    refuseAsTheValidatorWould,
  );

  router.openapi(deleteTypeRoute, async (c) => {
    const { id } = c.req.valid("param");

    if (isLockedPlatformType(id)) {
      throw new MarfaError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot delete platform-shipped types`,
      );
    }

    const { force } = c.req.valid("query");
    // The existence check, the questions and the delete are one transaction.
    // The store takes the type out of the registry before it commits, and a
    // create asks the registry inside its own transaction, so an item written
    // meanwhile either lands first and is counted or comes after and is
    // refused; of two deletes in flight, the second finds no type.
    await runAuditedTransaction(
      storage,
      async () => {
        const existing = getTypeSchema(id);
        if (!existing) {
          throw new MarfaError(
            ErrorCode.TYPE_NOT_FOUND,
            `Type "${id}" not found`,
          );
        }
        requireTypeSchemaWrite(c, "change", id);

        // Checked before the items refusal, and outside `force`, because this
        // one cannot be forced past. Reporting the forcible obstruction first
        // would send a caller round again to meet the one that stops them.
        //
        // Refusing rather than repairing the children is the deliberate choice.
        // A child that inherits IS its parent: `isSubtypeOf` answers yes and a
        // subtree query finds its items. Flattening the inherited fields down
        // would keep the field names and lose that, changing the child's
        // meaning as a side effect of a command naming a different type.
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
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "type.delete",
        resource_type: "type",
        resource_id: id,
      },
    );

    return c.json({ ok: true as const }, 200);
  });

  return router;
}
