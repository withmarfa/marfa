import { VersionWriterSchema } from "./_schemas.js";
import { assertCompatibleDependents } from "./_type-dependents.js";
import { canonicalTypeDefinition } from "./_canonical-type.js";
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
  STATUS_GROUPS,
  FIELD_FORMATS,
  malformedTypeIdentifier,
  labelledTypeDefinition,
  iconNameIssue,
} from "@withmarfa/shared";
import type { SchemaValidationIssue, TypeSchema } from "@withmarfa/shared";
import type { Context, Next } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  authorityId,
  heldPermissions,
  isDirectAuthority,
  requireRecentOwnerAuthentication,
  requireAuth,
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
import { CLOSED_BY_HANDLER } from "./_unknown-body-keys.js";
import {
  changesSchema,
  isLockedPlatformType,
  registersType,
  replacesType,
  requireParentReach,
  requireTypeReplacement,
  requireTypeSchemaWrite,
} from "./_schema-reach.js";
import { MergePolicySchema, nullableRef, wholeListOf } from "./_schemas.js";
import { planSettings, typeGrants } from "../type-move/settings.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Why a type can't be deleted yet, and what to do first. */
function typeInUseMessage(
  id: string,
  itemCount: number,
  settingCount: number,
  c: Context<AppEnv>,
): string {
  const items = `${String(itemCount)} ${itemCount === 1 ? "item" : "items"}`;
  const settings = `${String(settingCount)} folder, view or webhook ${settingCount === 1 ? "setting" : "settings"}`;
  const first =
    settingCount === 0
      ? `Type "${id}" still has ${items}.`
      : itemCount === 0
        ? `${settings} still ${settingCount === 1 ? "names" : "name"} type "${id}".`
        : `Type "${id}" still has ${items}, and ${settings} ${settingCount === 1 ? "names" : "name"} it.`;
  const move =
    itemCount > 0
      ? isDirectAuthority(c)
        ? " Move the items to another type first."
        : ` Move the items to another type first with POST /types/${id}/move${settingCount > 0 ? ", which also rewrites those settings" : ""}.`
      : " Change those settings first.";
  return isDirectAuthority(c)
    ? first + move
    : `${first}${move} Or use ?force=true to delete it anyway.`;
}

function requireDependencyReach(
  c: Context<AppEnv>,
  schema: TypeSchema,
  stored?: TypeSchema,
): void {
  if (schema.parent && schema.parent !== stored?.parent) {
    requireParentReach(c, schema.parent);
  }
  for (const target of schema.compatible_with ?? []) {
    if (!stored?.compatible_with?.includes(target)) {
      requireParentReach(c, target);
    }
  }
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

const rangeBound = (holder: string) =>
  `Only a \`number\` or \`integer\` ${holder} takes it.`;

/**
 * One member of a list entry. The kinds it may take are narrower than a
 * field's, and the validator refuses the rest as `invalid_schema`, naming the
 * member.
 */
const EntryMemberSchema = z
  .looseObject({
    type: z
      .enum(FIELD_TYPES as unknown as [string, ...string[]])
      .describe(
        "The member's type: `string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date` or `datetime`.",
      ),
    description: z.string().optional().describe("What the member holds."),
    required: z
      .boolean()
      .optional()
      .describe("`true` if every entry must have the member."),
    enum_values: z
      .array(z.string())
      .optional()
      .describe("The values an `enum` member allows."),
    format: z
      .enum(FIELD_FORMATS as unknown as [string, ...string[]])
      .optional()
      .describe("A refinement of a `string` member, as a field's `format`."),
    maxLength: z
      .number()
      .int()
      .optional()
      .describe("The longest value a `string` or `enum` member allows."),
    minimum: z
      .number()
      .optional()
      .describe(
        `The lowest value the member allows, itself included. ${rangeBound("member")}`,
      ),
    maximum: z
      .number()
      .optional()
      .describe(
        `The highest value the member allows, itself included. ${rangeBound("member")}`,
      ),
  })
  .describe("One member of the entries of an `array` field.")
  .openapi("EntryMember");

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
        "The field's type. A `thumbnail` is a base64 `data:` URI of a PNG, JPEG or WebP image up to 16 KiB, never `title`, `body`, `description` or `name`; a `status` is a word from `status_values`. A type has at most one of each, never as `items_type`.",
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
    status_values: z
      .array(
        z
          .object({
            value: z
              .string()
              .describe(
                "The word, such as `in_review`: a lowercase letter, then up to 63 lowercase letters, digits and underscores.",
              ),
            group: z
              .enum(STATUS_GROUPS)
              .describe("The group the word belongs to."),
          })
          .describe("One word a `status` field takes, with its group.")
          .openapi("StatusValue"),
      )
      .optional()
      .describe(
        "The words a `status` field takes, each in a group: `not_started`, `in_progress`, `completed` or `canceled`. A subtype lists only the words it adds. A type read answers every word, inherited first; the type list answers the type's own.",
      ),
    items_type: z
      .string()
      .optional()
      .describe(
        "The type of each element of an `array` field. A write is refused if an element is not a value of that type.",
      ),
    items_fields: z
      .record(z.string(), EntryMemberSchema)
      .optional()
      .describe(
        "The members of each entry of an `array` field whose `items_type` is `object`, by name. A write is refused if an entry has another member, lacks a required one, holds a value a member does not take, or has none.",
      ),
    format: z
      .enum(FIELD_FORMATS as unknown as [string, ...string[]])
      .optional()
      .describe(
        "A refinement of a `string` field or an array of strings. `url`, `email`, `datetime`, `date` and `thumbnail` become the `type` or `items_type`. `bcp47`, `iso3166` and `currency` stay as `format`; a `currency` is three capital letters, such as `GBP`.",
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
    minimum: z
      .number()
      .optional()
      .describe(
        `The lowest value the field allows, itself included. ${rangeBound("field")} A subtype may raise it, never lower or drop it.`,
      ),
    maximum: z
      .number()
      .optional()
      .describe(
        `The highest value the field allows, itself included. ${rangeBound("field")} A subtype may lower it, never raise or drop it.`,
      ),
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
      .describe(
        "The field that holds an item's body for display. The field holds Markdown.",
      ),
    icon: z
      .string()
      .optional()
      .describe(
        "The type's icon, as an Iconify ID, `<set>:<name>`, from a pinned version of `lucide` or `simple-icons`, such as `lucide:calendar-days`. On a type read back, the owner's own choice replaces the author's.",
      ),
  })
  .describe(
    "How clients show a type and its items: the fields that hold an item's title and body, and the type's icon. Each hint comes from the nearest type that sets it.",
  )
  .openapi("DisplayHints");

const MERGE_POLICY = "How Marfa merges conflicting edits to the type's items.";
const DISPLAY_HINTS =
  "How clients show the type and its items: the title field, the body field and the icon.";
const VERSION_POLICY = "How long Marfa keeps the versions of the type's items.";
const RETENTION_POLICY =
  "How long Marfa keeps the type's items in the feed tier.";
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

const RetentionPolicySchema = z
  .looseObject({
    feed_days: z
      .number()
      .nullable()
      .optional()
      .describe(
        "How many days Marfa keeps a feed item, counted from when it arrived: a whole number from 1 to 36,500. After that Marfa moves the item to the trash. `null` keeps feed items although a parent type expires them. Library items never expire.",
      ),
  })
  .describe(
    "How long Marfa keeps the feed items of a type. A part you leave out comes from the parent type. A type that no type in its chain gives a window keeps its items.",
  )
  .openapi("RetentionPolicy");

/**
 * A type as the two authoring doors take it.
 *
 * The objects are loose, so a key the declaration does not name reaches the
 * validator as it was sent, which refuses it as `invalid_schema` naming its
 * path, whether it sits at the top level or in a field, `display_hints` or
 * another block: one refusal in this door's own code, which restore applies
 * to an archived type too. A strict body would refuse the top-level key
 * alone, as `validation_error`, ahead of that check. `CLOSED_BY_HANDLER`
 * makes the document say what the door does, and
 * `refuseAsTheValidatorWould` answers the shape check with this door's codes
 * rather than a generic one.
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
  retention_policy: RetentionPolicySchema.optional().describe(RETENTION_POLICY),
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
  .describe("A declared item type.")
  .meta(CLOSED_BY_HANDLER)
  .openapi("TypeDefinitionInput");

const TypeProvenanceSchema = z
  .object({
    origin: z
      .enum(["platform", "user", "unknown"])
      .describe(
        "Where the type came from: shipped by Marfa, registered by a caller, or unknown.",
      ),
    created_by: VersionWriterSchema.nullable().describe(
      "The sign-in that first registered the type, or null when none is recorded.",
    ),
  })
  .describe(
    "Whether Marfa ships the type, and the sign-in that first registered it when known.",
  )
  .openapi("TypeProvenance");

/** This module's part of `DESCRIBED_ONLY_BY_REFERENCE` in `_schemas.ts`. */
export const TYPE_SCHEMAS_DESCRIBED_BY_REFERENCE: Readonly<
  Record<string, z.ZodType>
> = {
  DisplayHints: DisplayHintsSchema,
  VersionPolicy: VersionPolicySchema,
  RetentionPolicy: RetentionPolicySchema,
  TypeProvenance: TypeProvenanceSchema,
};

/**
 * The same body on the replacement door, where the path names the type.
 *
 * The path names the type, so an `id` in the body moves nothing; it is
 * declared because `GET /types/{id}` answers one, and a client that reads a
 * type, changes one thing and replaces it sends it back.
 */
const TypeDefinitionUpdateSchema = z
  .looseObject({
    ...typeDefinitionBody,
    provenance: TypeProvenanceSchema.optional().describe(
      "The recorded origin and creator, accepted when replacing a read response. This field cannot change either value.",
    ),
    id: z
      .string()
      .optional()
      .describe(
        "The type's identifier, as `GET /types/{id}` returns it. The path names the type, so an identifier here changes nothing.",
      ),
  })
  .describe("The schema that replaces a type's stored one.")
  .meta(CLOSED_BY_HANDLER)
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
      .int()
      .min(0)
      .describe("The version number the type was last saved with."),
    display_hints: DisplayHintsSchema.optional().describe(DISPLAY_HINTS),
    link_field: LinkFieldSchema.optional(),
    version_policy: VersionPolicySchema.optional().describe(VERSION_POLICY),
    merge_policy: MergePolicySchema.optional().describe(MERGE_POLICY),
    retention_policy:
      RetentionPolicySchema.optional().describe(RETENTION_POLICY),
  })
  .describe(
    "A type says which fields the items of that type hold, and what else Marfa does for them.",
  )
  .openapi("TypeDefinition");

const RegisteredTypeResponse = TypeSchemaResponse.extend({
  provenance: TypeProvenanceSchema.describe(
    "The type's recorded origin and creator.",
  ),
}).openapi("RegisteredType");

const ListedTypeResponse = RegisteredTypeResponse.extend({
  own_roles: TypeSchemaResponse.shape.roles
    .unwrap()
    .describe(
      "The structural roles the type declares itself, without those it only inherits. Empty if it declares none.",
    ),
})
  .describe(
    "A type in the list of types: its own definition, with the roles it declares and the roles it plays.",
  )
  .openapi("ListedType");

const TypeResponseSchema = z
  .object({ type: RegisteredTypeResponse.describe("The type.") })
  .describe("One type.")
  .openapi("TypeResponse");

/**
 * The type as it reads for this owner: their icon in place of the author's.
 * It is the type's own `display_hints.icon`, so a subtype that sets none
 * inherits it exactly as it would an author's, and one that sets its own
 * still shows that.
 */
function withOwnerIcon<T extends TypeSchema>(
  schema: T,
  owned: ReadonlyMap<string, string>,
): T {
  const icon = owned.get(schema.id);
  if (icon === undefined) return schema;
  return { ...schema, display_hints: { ...schema.display_hints, icon } };
}

const DISPLAY_HINT_KEYS = ["title_field", "body_field", "icon"] as const;

/**
 * The hints the type reads as, which is what a caller that reads a type and
 * writes the answer back submits. A parent chain that cannot be walked, the
 * state a replacement exists to correct, leaves nothing to compare with.
 */
function readDisplayHints(
  id: string,
  owned: ReadonlyMap<string, string>,
): TypeSchema["display_hints"] {
  try {
    return resolveTypeSchema(id, ownerResolver(owned))?.display_hints;
  } catch (err) {
    if (
      err instanceof MarfaError &&
      err.code === ErrorCode.TYPE_CHAIN_UNRESOLVABLE
    ) {
      return undefined;
    }
    throw err;
  }
}

/**
 * A definition written back as read carries more than its author wrote: the
 * owner's icon, and every hint the type takes from an ancestor. A hint the
 * stored definition does not set, and the submission gives the value the type
 * reads as, is that read-back, so it is dropped and the type goes on
 * following its ancestor. The icon the definition does set is kept when the
 * submitted one is the owner's, so clearing the owner's icon shows the
 * author's again.
 */
function withoutReadBack<T extends TypeSchema>(
  schema: T,
  stored: TypeSchema,
  owned: ReadonlyMap<string, string>,
): T {
  const submitted = schema.display_hints;
  if (submitted === undefined) return schema;
  const read = readDisplayHints(stored.id, owned);
  const ownerIcon = owned.get(stored.id);
  const hints: Record<string, string> = {};
  for (const key of DISPLAY_HINT_KEYS) {
    const value = submitted[key];
    if (value === undefined) continue;
    const own = stored.display_hints?.[key];
    if (key === "icon" && ownerIcon !== undefined && value === ownerIcon) {
      if (own !== undefined) hints[key] = own;
    } else if (own === undefined && value === read?.[key]) {
      continue;
    } else {
      hints[key] = value;
    }
  }
  const rest: Record<string, unknown> = { ...(schema as TypeSchema) };
  delete rest.display_hints;
  if (Object.keys(hints).length > 0) rest.display_hints = hints;
  return rest as T;
}

/** The registry as the owner sees it: each type with their icon, if any. */
function ownerResolver(owned: ReadonlyMap<string, string>): TypeResolver {
  return (id) => {
    const schema = getTypeSchema(id);
    return schema && withOwnerIcon(schema, owned);
  };
}

const TypeIconBodySchema = z
  .strictObject({
    icon: z
      .string()
      .describe(
        "An Iconify ID, `<set>:<name>`, from a set and version Marfa pins: `lucide` or `simple-icons`, such as `lucide:calendar-days` or `simple-icons:github`.",
      ),
  })
  .describe("The icon to show for a type.")
  .openapi("TypeIconRequest");

const typeIdParams = z.object({
  id: z
    .string()
    .describe(
      "The identifier of the type, such as `core.note` or `acme.deal`.",
    ),
});

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
          schema: wholeListOf(ListedTypeResponse, "TypeDefinitionPage", "type"),
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
          schema: RegisteredTypeResponse,
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
        "- `missing_required_field`: `fields` is missing.\n- `validation_error`: `id` is malformed, or `parent` isn't registered or makes too deep a chain.\n- `invalid_schema`: the schema is invalid or has a key it doesn't define (`details.errors` names each path).\n- `property_shadows_field`: a field is named like one every item has.\n- `inheritance_violation`: the type reshapes an inherited field.",
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
        "- `forbidden`: you don't have `metadata.types:write`, or the identifier is under `core.*`, `system.*` or `marfa.*`, which no credential can register.\n- `type_not_permitted`: your type map lacks write on the identifier or a non-platform `parent` or `compatible_with` target (`details.grant` names it).",
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

const normalizeTypeRoute = createRoute({
  operationId: "normalizeType",
  method: "post",
  path: "/normalize",
  tags: ["Types"],
  summary: "Normalize a type definition",
  description:
    "Normalizes a candidate definition and returns its declared form, the registered declared definition and the registered resolved definition. It does not register or replace a type.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: TypeDefinitionInputSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              type: TypeSchemaResponse.describe(
                "The normalized candidate's declared definition, including its label and defaults.",
              ),
              registered_type: nullableRef(TypeSchemaResponse).describe(
                "The canonical registered type's declared definition; `null` if its identifier is not registered.",
              ),
              resolved_type: nullableRef(TypeSchemaResponse).describe(
                "The canonical registered definition, with inherited fields, policies and roles resolved as on `GET /types/{id}`, with the author's icon and not the owner's; `null` if its identifier is not registered.",
              ),
            })
            .describe(
              "Canonical definitions from one registry view, with field defaults made explicit as `required: false` and `searchable: true`.",
            )
            .openapi("NormalizedType"),
        },
      },
      description:
        "Returns the normalized candidate and the registered definitions.",
    },
    400: registerTypeRoute.responses[400],
    401: registerTypeRoute.responses[401],
    409: getTypeRoute.responses[409],
    422: registerTypeRoute.responses[422],
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
        "- `missing_required_field`: `fields` is missing.\n- `validation_error`: `id` is malformed, or `parent` isn't registered or makes a bad chain.\n- `invalid_schema`: the schema is invalid or has a key it doesn't define (`details.errors` names each path).\n- `property_shadows_field`: a field has the name of one every item has.\n- `inheritance_violation`: a field's shape differs in a parent or subtype.",
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
        "- `forbidden`: you lack `schema.write` and `metadata.types:write`, or `details.changes` names changes needing `schema.write`.\n- `core_type_immutable`: Marfa ships this type.\n- `type_not_permitted`: your type map lacks write on the type or a new non-platform `parent` or `compatible_with` target (`details.grant` names it).",
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
        "`compatible_with_violation`: `compatible_with` names a type this instance doesn't hold, or one the type doesn't satisfy, or the change breaks another type's claim (`details.dependent_type_ids`).",
    },
  },
});

function requireIconDoorId(c: Context<AppEnv>, next: Next) {
  const id = c.req.param("id") ?? "";
  if (!isValidTypeIdentifier(id)) {
    throw malformedTypeIdentifier("id", `Invalid type identifier: ${id}`);
  }
  return next();
}

const iconDoorResponses = {
  401: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
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
      "- `forbidden`: you lack `schema.write`, or your key is a connector's, which cannot change what the owner chose.\n- `type_not_permitted`: your type map doesn't grant write on the type.",
  },
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["type_not_found"]),
      },
    },
    description: "`type_not_found`: no type has this identifier.",
  },
} as const;

const setTypeIconRoute = createRoute({
  operationId: "setTypeIcon",
  method: "put",
  path: "/{id}/icon",
  middleware: [changesSchema, requireIconDoorId] as const,
  tags: ["Types"],
  summary: "Set a type's icon",
  description:
    "Sets the owner's icon for a type. Reads answer it in place of the author's, and a subtype with no icon inherits it. Replacing the type keeps it. Needs `schema.write` and write on the type, as replacing it does.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  request: {
    params: typeIdParams,
    query: z.object({}),
    body: { content: { "application/json": { schema: TypeIconBodySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TypeResponseSchema } },
      description: "Returns the type, with the icon.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_schema"]),
        },
      },
      description:
        "`invalid_schema`: `icon` isn't the ID of an icon in a pinned set (`details.errors` names it).",
    },
    ...iconDoorResponses,
  },
});

const clearTypeIconRoute = createRoute({
  operationId: "clearTypeIcon",
  method: "delete",
  path: "/{id}/icon",
  middleware: [changesSchema, requireIconDoorId] as const,
  tags: ["Types"],
  summary: "Clear a type's icon",
  description:
    "Removes the icon the owner set for a type, so reads show the author's again. Clearing a type with no owner icon succeeds and changes nothing.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  request: { params: typeIdParams, query: z.object({}) },
  responses: {
    200: {
      content: { "application/json": { schema: TypeResponseSchema } },
      description: "Returns the type, with the author's icon if it has one.",
    },
    ...iconDoorResponses,
  },
});

const deleteTypeRoute = createRoute({
  operationId: "deleteType",
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a type",
  description:
    "Deletes a type no item holds and no folder, view or webhook names. With `force=true`, a key keeps the items without their type and leaves the settings as they are; new writes then fail until it's registered again.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
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
          "Delete the type even if items of it exist, in any state, or a folder, view or webhook names it. It doesn't cover subtypes or compatibility dependents.",
        ),
    }),
  },
  responses: {
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["compatible_with_violation"]),
        },
      },
      description:
        "`compatible_with_violation`: other types name this type in `compatible_with`. `details.dependent_type_ids` lists them. Remove their claims before deleting the target; `force=true` does not bypass this check.",
    },
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
        "- `forbidden`: you lack `schema.write`, your owner sign-in is too old, or direct authority requested `force=true`.\n- `core_type_immutable`: Marfa ships this type, and no credential can delete it.\n- `type_not_permitted`: your type map doesn't grant write on the type.",
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
        "- `type_has_subtypes`: other types name this one as their `parent` (`details.subtype_ids` lists them). Delete them, or give them another parent with `PUT /types/{id}`.\n- `type_in_use`: an item of the type exists, in any state, or a folder, view or webhook names it, and `force` isn't `true`. `details` counts the items and lists the settings. Move them with `POST /types/{id}/move`.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function typeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTypesRoute, async (c) => {
    requireAuth(c);
    const data = await storage.runInReadSnapshot(
      async () => {
        const rows = new Map(
          (await storage.types.loadAll()).map((row) => [row.schema.id, row]),
        );
        const resolve: TypeResolver = (id) => getTypeSchema(id);
        const owned = await storage.types.icons();
        return listTypes()
          .map((schema) => withOwnerIcon(schema, owned))
          .map((schema) => {
            const roles = resolveRoles(schema.id, resolve);
            const row = rows.get(schema.id);
            return {
              ...schema,
              ...(roles ? { roles } : {}),
              own_roles: [...(schema.roles ?? [])].sort(),
              provenance: {
                origin: row?.origin ?? ("unknown" as const),
                created_by: row?.created_by ?? null,
              },
            };
          });
      },
      { signal: c.req.raw.signal },
    );
    return c.json({ data, next_cursor: null }, 200);
  });

  router.openapi(getTypeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const result = await storage.runInReadSnapshot(
      async () => {
        const owned = await storage.types.icons();
        const schema = resolveTypeSchema(id, ownerResolver(owned));
        if (!schema)
          throw new MarfaError(
            ErrorCode.TYPE_NOT_FOUND,
            `Type "${id}" not found`,
          );
        return { ...schema, provenance: await storage.types.provenance(id) };
      },
      { signal: c.req.raw.signal },
    );
    return c.json(result, 200);
  });

  router.openapi(
    normalizeTypeRoute,
    async (c) => {
      requireAuth(c);
      const body = c.req.valid("json");
      if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
        throw malformedTypeIdentifier(
          "id",
          `Invalid type identifier: ${body.id}`,
        );
      }
      const result = await storage.runInReadSnapshot(
        () => {
          const validated = validateTypeSchema(body);
          if (!validated.success) throw schemaRefusal(validated.errors);
          const type = canonicalTypeDefinition(validated.data);
          if (type.parent) validateParentChain(type.id, type.parent);
          const stored = getTypeSchema(type.id);
          const registered_type = stored
            ? canonicalTypeDefinition(stored)
            : null;
          const resolved = resolveTypeSchema(type.id, getTypeSchema);
          const resolved_type = resolved
            ? canonicalTypeDefinition(resolved)
            : null;
          return { type, registered_type, resolved_type };
        },
        { signal: c.req.raw.signal },
      );
      return c.json(result, 200);
    },
    refuseAsTheValidatorWould,
  );

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
        // Asked again in the transaction, of the key as it stands there.
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
          if (typeof body.id === "string")
            requireTypeSchemaWrite(c, "register", body.id);
          const result = validateTypeSchema(body);
          if (!result.success) {
            throw schemaRefusal(result.errors);
          }

          const schema = result.data;

          labelledTypeDefinition(schema);

          requireDependencyReach(c, schema);
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
          assertCompatibleDependents([schema.id]);
          return {
            ...created,
            provenance: await storage.types.provenance(created.id),
          };
        },
        (created) => ({
          client_ip: c.get("clientIp") ?? null,
          key_id: c.get("apiKey")?.id,
          action: "type.register",
          resource_type: "type",
          resource_id: created.id,
        }),
        undefined,
        "type.register",
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
          requireTypeSchemaWrite(c, "replace", id);
          const definition = { ...body };
          delete definition.provenance;
          const result = validateTypeSchema({ ...definition, id });
          if (!result.success) {
            throw schemaRefusal(result.errors);
          }

          const schema = withoutReadBack(
            labelledTypeDefinition(result.data),
            stored,
            await storage.types.icons(),
          );
          await requireTypeReplacement(c, stored, schema, (types, names) =>
            storage.types.propertyNamesHeld(types, names),
          );
          requireDependencyReach(c, schema, stored);
          if (schema.parent) {
            // Measured on the type as it stands, before the update lands, which
            // is the subtree that would move with it.
            validateParentChain(
              schema.id,
              schema.parent,
              maxDescendantDepth(schema.id),
            );
          }
          const updated = await storage.types.update(id, schema);
          assertCompatibleDependents([id]);
          return {
            ...withOwnerIcon(updated, await storage.types.icons()),
            provenance: await storage.types.provenance(id),
          };
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

  /** Admit the caller to change the owner's icon for `id`, or refuse it. The
   *  owner and a local command may; a key needs `schema.write` and write on
   *  the type in its map, the same as to replace the type. */
  function requireIconChange(c: Context<AppEnv>, id: string) {
    if (!getTypeSchema(id)) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    if (isDirectAuthority(c)) return;
    requireTypeSchemaWrite(c, "change", id);
  }

  async function iconAnswer(id: string) {
    const owned = await storage.types.icons();
    const schema = resolveTypeSchema(id, ownerResolver(owned));
    if (!schema) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    return {
      type: { ...schema, provenance: await storage.types.provenance(id) },
    };
  }

  router.openapi(setTypeIconRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { icon } = c.req.valid("json");
    const refused = iconNameIssue(icon, "icon");
    if (refused) {
      throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid type icon", {
        errors: [refused],
      });
    }
    const answer = await runAuditedTransaction(
      storage,
      async () => {
        requireIconChange(c, id);
        await storage.types.setIcon(id, icon);
        return iconAnswer(id);
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "type.icon.set",
        resource_type: "type",
        resource_id: id,
      },
    );
    return c.json(answer, 200);
  });

  router.openapi(clearTypeIconRoute, async (c) => {
    const { id } = c.req.valid("param");
    const answer = await runAuditedTransaction(
      storage,
      async () => {
        requireIconChange(c, id);
        await storage.types.clearIcon(id);
        return iconAnswer(id);
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "type.icon.clear",
        resource_type: "type",
        resource_id: id,
      },
    );
    return c.json(answer, 200);
  });

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
        if (isDirectAuthority(c)) {
          requireRecentOwnerAuthentication(c);
          if (force === "true")
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              "The owner console removes only unused types. Move their items to another type, and change the folders, views and webhooks that name them, first.",
            );
        } else requireTypeSchemaWrite(c, "change", id);

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
          // Every state, because the question is whether anything is written
          // against this type, not whether anything is being worked on. A row
          // in the bin or the archive still names the type it was validated
          // against, and deleting it out from under one leaves a row whose
          // shape nothing can check.
          const itemCount = await storage.items.countByType(id);
          const { settings } = await planSettings(
            storage,
            id,
            null,
            isDirectAuthority(c)
              ? null
              : { key: requireAuth(c), permissions: heldPermissions(c) },
          );
          if (itemCount > 0 || settings.length > 0) {
            const grants = await typeGrants(storage, c, id);
            throw new MarfaError(
              ErrorCode.TYPE_IN_USE,
              typeInUseMessage(id, itemCount, settings.length, c),
              { item_count: itemCount, settings, grants },
            );
          }
        }
        await storage.types.delete(id);
        assertCompatibleDependents([id]);
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "type.delete",
        resource_type: "type",
        resource_id: id,
      },
    );

    return c.json({ ok: true as const }, 200);
  });

  return router;
}
