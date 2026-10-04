// The single validator for type schemas, shared by both authoring paths: the
// build-time codegen that reads `core/*.json` and `core/system/*.json`, and
// the runtime `POST /types` endpoint. Both call `validateTypeSchema` and both get
// the same normalization, the same rules, and the same errors — a schema that
// is legal in-tree is legal over the wire, byte for byte.
//
// Dependency-free on purpose. `@withmarfa/shared` depends on this package, so
// nothing here may reach back into shared; registry access is injected through
// `SchemaValidationContext` instead.

import { TYPE_ROLES } from "./schema-types.js";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
  EdgeWrittenAt,
  FieldDefinition,
  FieldFormat,
  FieldType,
  TypeRole,
  TypeSchema,
} from "./schema-types.js";

/**
 * Prefix marking an edge-constraint entry as a role rather than a type
 * identifier. A colon cannot appear in a type identifier, so the two forms
 * can never be confused for one another.
 */
export const ROLE_CONSTRAINT_PREFIX = "role:";

const TYPE_ROLE_SET: ReadonlySet<string> = new Set<string>(TYPE_ROLES);

/** Whether a constraint entry names a role. */
export function isRoleConstraint(entry: string): boolean {
  return entry.startsWith(ROLE_CONSTRAINT_PREFIX);
}

/** The role an entry names, or `undefined` if it does not name one. */
export function roleFromConstraint(entry: string): TypeRole | undefined {
  if (!isRoleConstraint(entry)) return undefined;
  const name = entry.slice(ROLE_CONSTRAINT_PREFIX.length);
  return TYPE_ROLE_SET.has(name) ? (name as TypeRole) : undefined;
}

export const FIELD_TYPES: readonly FieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "url",
  "email",
  "datetime",
  "date",
  "enum",
  "array",
  "object",
  "thumbnail",
];

export const FIELD_FORMATS: readonly FieldFormat[] = [
  "url",
  "email",
  "datetime",
  "date",
  "thumbnail",
  "bcp47",
  "iso3166",
];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set<string>(FIELD_TYPES);
const FIELD_FORMAT_SET: ReadonlySet<string> = new Set<string>(FIELD_FORMATS);

/**
 * Formats that have a first-class `FieldType` of the same name. A string
 * field declaring one is normalized to the equivalent `type`, and an array of
 * strings to the equivalent `items_type`, so there is exactly one
 * representation of a URL field in the registry, however it was authored. The
 * formats absent from this map (`bcp47`, `iso3166`) annotate a `string` field
 * and survive normalization as `format`.
 */
const FORMAT_TO_FIELD_TYPE: Readonly<Partial<Record<FieldFormat, FieldType>>> =
  {
    url: "url",
    email: "email",
    datetime: "datetime",
    date: "date",
    thumbnail: "thumbnail",
  };

/**
 * The property names full-text search indexes whatever their field type. A
 * thumbnail may not take one, because its base64 would then be searchable.
 */
export const ALWAYS_SEARCHED_FIELDS = [
  "title",
  "body",
  "description",
  "name",
] as const;

export const MERGE_STRATEGIES: readonly string[] = [
  "last_writer_wins",
  "keep_both_copies",
];

/**
 * First-class field names on the `Item` wire shape. A type schema may not
 * declare `fields.<name>` for any name in this set — doing so would let a row
 * carry two values under the same key (the first-class column and the
 * shadowing property), with nothing telling a downstream consumer which is
 * authoritative.
 *
 * Lives here rather than in the consuming package so the build-time and
 * runtime checks read one list instead of two copies that drift. The list is
 * derived from the `Item` interface in `@withmarfa/shared`; a freshness test
 * there rebuilds it from a typed `Item` literal and fails if the two diverge.
 */
export const RESERVED_ITEM_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "state",
  "tier",
  "properties",
  "created_at",
  "updated_at",
  "occurred_at",
  "source",
  "source_id",
  "version",
  "schema_version",
  "capture_latitude",
  "capture_longitude",
  "trashed_by_cascade",
  "trashed_with",
]);

/**
 * A single validation failure, self-describing by construction.
 *
 * Every issue carries the four things a reader needs to act without opening
 * the validator: where it happened (`field`), what was required (`expected`),
 * what arrived (`actual`), and what to do about it (`hint`). `message` is the
 * three composed into one sentence for surfaces that render a flat string.
 */
export interface SchemaValidationIssue {
  /** Dot-path to the offending location, e.g. `fields.stage.enum_values`. */
  field: string;
  /** `expected`, `actual` and `hint` composed into one readable sentence. */
  message: string;
  /**
   * Machine-readable discriminator for the failure classes the API maps onto
   * dedicated error codes: `property_shadows_field`, `inheritance_violation`,
   * `compatible_with_violation`. Absent for generic shape failures.
   */
  code?: string;
  /** What the validator required at this path. */
  expected: string;
  /** What the submitted schema carried at this path. */
  actual: string;
  /** The concrete next step that resolves the failure. */
  hint: string;
}

export type TypeSchemaValidationResult =
  | { success: true; data: TypeSchema }
  | { success: false; errors: SchemaValidationIssue[] };

export interface SchemaValidationContext {
  /**
   * Resolves an already-registered schema by identifier, for the inheritance
   * and `compatible_with` checks. The runtime binds this to the registry
   * lookup; the codegen binds it to the in-tree schema map.
   */
  resolveSchema: (typeId: string) => TypeSchema | undefined;
  /**
   * Validates a type identifier against the namespace grammar. Injected
   * because the grammar lives in `@withmarfa/shared`, which depends on this
   * package. Omit to skip the identifier check (the codegen path, where the
   * filename already pins the identifier).
   */
  isValidTypeIdentifier?: (value: string) => boolean;
  /**
   * Every registered type whose parent chain reaches `typeId`, for the rules
   * a change to a parent can break in a child it already has. Omit where no
   * type is registered yet (the codegen path).
   */
  descendantsOf?: (typeId: string) => TypeSchema[];
}

// ---------------------------------------------------------------------------
// Issue construction
// ---------------------------------------------------------------------------

function issue(
  parts: Omit<SchemaValidationIssue, "message">,
): SchemaValidationIssue {
  return {
    ...parts,
    message: `Expected ${parts.expected}; received ${parts.actual}. ${parts.hint}`,
  };
}

/** Renders an arbitrary value for the `actual` half of an issue. */
function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Folds one authored field definition into the canonical `FieldDefinition`.
 * Applies the format-to-type collapse and drops keys the model does not carry,
 * so a definition that survives normalization is exactly what the registry
 * stores and exactly what the validator downstream sees.
 *
 * Shape errors are not reported here — `validateTypeSchema` checks the raw
 * input first and only normalizes what already passed.
 */
export function normalizeFieldDefinition(
  raw: Record<string, unknown>,
  options?: { required?: boolean },
): FieldDefinition {
  const declaredFormat =
    typeof raw.format === "string" && FIELD_FORMAT_SET.has(raw.format)
      ? (raw.format as FieldFormat)
      : undefined;
  const collapsed = declaredFormat
    ? FORMAT_TO_FIELD_TYPE[declaredFormat]
    : undefined;
  const isList = raw.type === "array";
  const type = (isList ? raw.type : (collapsed ?? raw.type)) as FieldType;

  const out: FieldDefinition = { type };
  if (typeof raw.description === "string" && raw.description.length > 0) {
    out.description = raw.description;
  }
  const required = options?.required ?? raw.required === true;
  if (required) out.required = true;
  if (Array.isArray(raw.enum_values)) {
    out.enum_values = raw.enum_values as string[];
  }
  if (typeof raw.items_type === "string") {
    out.items_type = isList ? (collapsed ?? raw.items_type) : raw.items_type;
  }
  // A format that collapses into a field type is carried by `type` or
  // `items_type` alone, since keeping it too would give the same field two
  // spellings. Only a format that annotates without changing the type is kept.
  if (declaredFormat && !collapsed) out.format = declaredFormat;
  if (raw.searchable === false) out.searchable = false;
  if (typeof raw.maxLength === "number") out.maxLength = raw.maxLength;
  if (typeof raw.maxItems === "number") out.maxItems = raw.maxItems;
  return out;
}

/**
 * Collects the required field names declared either way. In-tree JSON carries
 * a top-level `required: string[]`; a runtime submission usually sets
 * `required: true` on the field itself. Both are legal and both mean the same
 * thing, so the validator reads both and the registry stores one.
 */
function collectRequiredNames(input: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(input.required)) {
    for (const name of input.required) {
      if (typeof name === "string") names.add(name);
    }
  }
  const fields = asRecord(input.fields);
  if (fields) {
    for (const [name, def] of Object.entries(fields)) {
      const record = asRecord(def);
      if (record?.required === true) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Field-level validation
// ---------------------------------------------------------------------------

function validateFieldShape(
  name: string,
  def: unknown,
  errors: SchemaValidationIssue[],
): void {
  const fd = asRecord(def);
  if (!fd) {
    errors.push(
      issue({
        field: `fields.${name}`,
        expected: "an object describing the field",
        actual: describe(def),
        hint: `Write fields.${name} as { "type": "string", "description": "..." }.`,
      }),
    );
    return;
  }

  const declaredFormat = typeof fd.format === "string" ? fd.format : undefined;

  if (typeof fd.type !== "string" || fd.type.length === 0) {
    errors.push(
      issue({
        field: `fields.${name}.type`,
        expected: `one of: ${FIELD_TYPES.join(", ")}`,
        actual: describe(fd.type),
        hint: "Every field declares a type. Use `string` when in doubt.",
      }),
    );
  } else if (!FIELD_TYPE_SET.has(fd.type)) {
    errors.push(
      issue({
        field: `fields.${name}.type`,
        expected: `one of: ${FIELD_TYPES.join(", ")}`,
        actual: describe(fd.type),
        hint: `"${fd.type}" is not a field type. For a semantic refinement of a string, use "format" instead.`,
      }),
    );
  }

  if (declaredFormat !== undefined) {
    if (!FIELD_FORMAT_SET.has(declaredFormat)) {
      errors.push(
        issue({
          field: `fields.${name}.format`,
          expected: `one of: ${FIELD_FORMATS.join(", ")}`,
          actual: describe(fd.format),
          hint: "Drop the format, or pick one of the supported values.",
        }),
      );
    } else {
      const collapsed = FORMAT_TO_FIELD_TYPE[declaredFormat as FieldFormat];
      if (collapsed) {
        const fitsList =
          fd.type === "array" &&
          collapsed !== "thumbnail" &&
          (fd.items_type === "string" || fd.items_type === collapsed);
        if (fd.type !== "string" && fd.type !== collapsed && !fitsList) {
          errors.push(
            issue({
              field: `fields.${name}.format`,
              expected:
                collapsed === "thumbnail"
                  ? `format "thumbnail" on a string field`
                  : `format "${declaredFormat}" on a string field, a ${collapsed} field or a list of strings`,
              actual: `format "${declaredFormat}" on a ${describe(fd.type)} field`,
              hint: `Set the field type to "${collapsed}" and drop the format.`,
            }),
          );
        }
      } else if (fd.type !== "string") {
        errors.push(
          issue({
            field: `fields.${name}.format`,
            expected: `format "${declaredFormat}" on a string field`,
            actual: `format "${declaredFormat}" on a ${describe(fd.type)} field`,
            hint: `The ${declaredFormat} format annotates string contents. Set the field type to "string".`,
          }),
        );
      }
    }
  }

  if (fd.type === "enum") {
    if (!Array.isArray(fd.enum_values)) {
      errors.push(
        issue({
          field: `fields.${name}.enum_values`,
          expected: "a non-empty array of allowed string values",
          actual: describe(fd.enum_values),
          hint: `Add enum_values, e.g. ["open", "closed"], or change the type to "string".`,
        }),
      );
    } else if (fd.enum_values.length === 0) {
      errors.push(
        issue({
          field: `fields.${name}.enum_values`,
          expected: "a non-empty array of allowed string values",
          actual: "an empty array",
          hint: "An enum with no values can never validate. List the allowed values.",
        }),
      );
    } else if (!fd.enum_values.every((v: unknown) => typeof v === "string")) {
      errors.push(
        issue({
          field: `fields.${name}.enum_values`,
          expected: "every entry to be a string",
          actual: describe(fd.enum_values),
          hint: "Enum values cross the wire as JSON strings. Quote the non-string entries.",
        }),
      );
    }
  }

  if (fd.type === "array" && typeof fd.items_type !== "string") {
    errors.push(
      issue({
        field: `fields.${name}.items_type`,
        expected: "a string naming the element type",
        actual: describe(fd.items_type),
        hint: `Add items_type, e.g. "string" or "object".`,
      }),
    );
  }

  // An array's elements are not validated as their items_type says, so an
  // array of thumbnails would carry images nothing checks, under a name the
  // one-thumbnail rule never counts.
  if (fd.items_type === "thumbnail") {
    errors.push(
      issue({
        field: `fields.${name}.items_type`,
        expected: "an element type other than thumbnail",
        actual: '"thumbnail"',
        hint: "A thumbnail is one image a type carries. Declare it as its own field of type thumbnail.",
      }),
    );
  }

  if (fd.searchable !== undefined && typeof fd.searchable !== "boolean") {
    errors.push(
      issue({
        field: `fields.${name}.searchable`,
        expected: "a boolean",
        actual: describe(fd.searchable),
        hint: "Set searchable: false to keep the field out of full-text search; omit it to index the field.",
      }),
    );
  }

  for (const cap of ["maxLength", "maxItems"] as const) {
    const value = fd[cap];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errors.push(
        issue({
          field: `fields.${name}.${cap}`,
          expected: "a positive integer",
          actual: describe(value),
          hint: `${cap} bounds a single field's size; a value below 1 would reject every write.`,
        }),
      );
    }
  }

  if (
    fd.maxLength !== undefined &&
    fd.type !== "string" &&
    fd.type !== "enum"
  ) {
    errors.push(
      issue({
        field: `fields.${name}.maxLength`,
        expected: "maxLength on a string or enum field",
        actual: `maxLength on a ${describe(fd.type)} field`,
        hint: "maxLength bounds string length. Use maxItems for arrays; drop it elsewhere.",
      }),
    );
  }

  if (fd.maxItems !== undefined && fd.type !== "array") {
    errors.push(
      issue({
        field: `fields.${name}.maxItems`,
        expected: "maxItems on an array field",
        actual: `maxItems on a ${describe(fd.type)} field`,
        hint: "maxItems bounds element count. Use maxLength for strings; drop it elsewhere.",
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

/**
 * Walks a parent chain and returns the nearest declaration of each visible
 * field, plus the type that declared it. Stops on an unresolvable parent and
 * on a cycle, so a malformed chain degrades to a partial view rather than
 * hanging the request.
 *
 * **The odd one out among the chain walks, deliberately.** Every other one
 * carries a depth bound and throws on reaching it; this carries only the
 * `seen` set, so its depth is bounded by the number of distinct types rather
 * than by a number. That cannot spin and never throws, so it is not a live
 * fault, and it is what lets a type whose chain is already broken still be
 * validated and therefore corrected.
 *
 * Giving it a bound is a behavior change to the validator, not a tightening
 * of this function: it would decide that a submission naming a broken
 * ancestor is refused rather than validated against what resolves, which is
 * a question about the authoring contract and wants deciding as one.
 */
function collectAncestorFields(
  parentId: string,
  ctx: SchemaValidationContext,
): Map<string, { owner: string; definition: FieldDefinition }> {
  const owners = new Map<
    string,
    { owner: string; definition: FieldDefinition }
  >([]);
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ancestor = ctx.resolveSchema(cursor);
    if (!ancestor) break;
    for (const [name, definition] of Object.entries(ancestor.fields)) {
      if (!owners.has(name)) owners.set(name, { owner: cursor, definition });
    }
    cursor = ancestor.parent;
  }
  return owners;
}

/**
 * Attributes that fix an inherited field's shape. A child re-stating a field
 * may sharpen its prose or tighten it to required — both resolve
 * unambiguously, and both are how the shipped subtypes are actually written.
 * Changing any of these instead redefines what the field *is*, which leaves
 * two incompatible readings of one property name on items that a
 * parent-typed reader expects to understand.
 */
const SHAPE_ATTRIBUTES = [
  "type",
  "format",
  "items_type",
  "searchable",
  "maxLength",
  "maxItems",
] as const;

function describeShapeConflict(
  child: FieldDefinition,
  ancestor: FieldDefinition,
): { attribute: string; expected: string; actual: string } | null {
  for (const attribute of SHAPE_ATTRIBUTES) {
    if (child[attribute] !== ancestor[attribute]) {
      return {
        attribute,
        expected: `${attribute} ${describe(ancestor[attribute])}`,
        actual: `${attribute} ${describe(child[attribute])}`,
      };
    }
  }
  const childEnum = child.enum_values?.join("|");
  const ancestorEnum = ancestor.enum_values?.join("|");
  if (childEnum !== ancestorEnum) {
    return {
      attribute: "enum_values",
      expected: `enum_values ${describe(ancestor.enum_values)}`,
      actual: `enum_values ${describe(child.enum_values)}`,
    };
  }
  if (ancestor.required === true && child.required !== true) {
    return {
      attribute: "required",
      expected: "required true (inherited)",
      actual: describe(child.required),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/**
 * Top-level keys `validateTypeSchema` reads only to refuse. Lifecycle is
 * universal and metadata-layer, so a per-type state machine has no effect
 * and would mislead whoever wrote it. `unreadTopLevelKeys` leaves these to
 * the validator, which already names each one.
 */
export const REFUSED_TYPE_SCHEMA_KEYS: readonly string[] = [
  "states",
  "default_state",
  "transitions",
];

/**
 * Validates and normalizes a type schema. On success the returned `data` is
 * the canonical `TypeSchema` — the exact shape the registry stores, whichever
 * authoring path produced the input.
 */
export function validateTypeSchema(
  input: unknown,
  ctx: SchemaValidationContext,
): TypeSchemaValidationResult {
  const obj = asRecord(input);
  if (!obj) {
    return {
      success: false,
      errors: [
        issue({
          field: "_root",
          expected: "a JSON object describing the type",
          actual: describe(input),
          hint: "A type schema is an object with at least `id` and `fields`.",
        }),
      ],
    };
  }

  const errors: SchemaValidationIssue[] = [];

  if (typeof obj.id !== "string") {
    errors.push(
      issue({
        field: "id",
        expected: "a dot-separated type identifier, e.g. acme.deal",
        actual: describe(obj.id),
        hint: "Every type needs an id under a namespace you own.",
      }),
    );
  } else if (ctx.isValidTypeIdentifier && !ctx.isValidTypeIdentifier(obj.id)) {
    errors.push(
      issue({
        field: "id",
        expected:
          "an identifier matching the namespace grammar: core.<type>, system.<type>, app.<app-name>.<type>, user.<type>, or <publisher>.<type>",
        actual: describe(obj.id),
        hint: "Segments are lowercase, separated by dots. Forward slashes and reserved-root collisions are rejected.",
      }),
    );
  }

  if (obj.label !== undefined && typeof obj.label !== "string") {
    errors.push(
      issue({
        field: "label",
        expected: "a string, or nothing",
        actual: describe(obj.label),
        hint: "label is the human-facing name. Omit it to derive one from the id.",
      }),
    );
  }

  if (obj.description !== undefined && typeof obj.description !== "string") {
    errors.push(
      issue({
        field: "description",
        expected: "a string, or nothing",
        actual: describe(obj.description),
        hint: "description is rendered on the consent screen and in the type catalog.",
      }),
    );
  }

  if (obj.parent !== undefined && typeof obj.parent !== "string") {
    errors.push(
      issue({
        field: "parent",
        expected: "a type identifier string, or nothing",
        actual: describe(obj.parent),
        hint: "Set parent to inherit an existing type's fields, or omit it for a standalone type.",
      }),
    );
  }

  if (
    obj.version !== undefined &&
    (typeof obj.version !== "number" ||
      !Number.isInteger(obj.version) ||
      obj.version < 0)
  ) {
    errors.push(
      issue({
        field: "version",
        expected: "a non-negative integer",
        actual: describe(obj.version),
        hint: "Versions are integers from 0. Omit the field to default to 0.",
      }),
    );
  }

  if (obj.required !== undefined) {
    if (!Array.isArray(obj.required)) {
      errors.push(
        issue({
          field: "required",
          expected: "an array of field names, or nothing",
          actual: describe(obj.required),
          hint: 'Required-ness may be declared either as a top-level ["title"] array or as required: true on the field.',
        }),
      );
    } else {
      for (const entry of obj.required) {
        if (typeof entry !== "string") {
          errors.push(
            issue({
              field: "required",
              expected: "every entry to name a field",
              actual: describe(entry),
              hint: "List field names as strings.",
            }),
          );
        }
      }
    }
  }

  for (const forbiddenKey of REFUSED_TYPE_SCHEMA_KEYS) {
    if (forbiddenKey in obj) {
      errors.push(
        issue({
          field: forbiddenKey,
          expected: `no \`${forbiddenKey}\` key`,
          actual: `a \`${forbiddenKey}\` declaration`,
          hint: "Lifecycle is universal (active / archived / trashed) and is not declared per type. Remove the key.",
        }),
      );
    }
  }

  const fields = asRecord(obj.fields);
  if (!fields) {
    errors.push(
      issue({
        field: "fields",
        expected: "an object mapping field names to definitions",
        actual: describe(obj.fields),
        hint: 'Declare at least one field, e.g. { "title": { "type": "string" } }.',
      }),
    );
  } else {
    for (const fieldName of Object.keys(fields)) {
      if (RESERVED_ITEM_FIELDS.has(fieldName)) {
        errors.push(
          issue({
            field: `fields.${fieldName}`,
            code: "property_shadows_field",
            expected: `a property name that is not a first-class Item field`,
            actual: `"${fieldName}", which is a first-class Item field`,
            hint: `Set the Item field "${fieldName}" directly instead, or rename this property to something type-specific.`,
          }),
        );
      }
    }

    for (const [name, def] of Object.entries(fields)) {
      validateFieldShape(name, def, errors);
    }
  }

  const requiredNames = collectRequiredNames(obj);

  // Inheritance. A child adds fields and may refine an inherited one's prose
  // or tighten it to required; it may not change what the field is.
  const parentId =
    typeof obj.parent === "string" && obj.parent.length > 0
      ? obj.parent
      : undefined;
  const ancestorFields = parentId
    ? collectAncestorFields(parentId, ctx)
    : new Map<string, { owner: string; definition: FieldDefinition }>();

  if (fields) {
    for (const [name, def] of Object.entries(fields)) {
      const ancestor = ancestorFields.get(name);
      if (!ancestor) continue;
      const raw = asRecord(def);
      if (!raw) continue;
      const normalized = normalizeFieldDefinition(raw, {
        required: requiredNames.has(name),
      });
      const conflict = describeShapeConflict(normalized, ancestor.definition);
      if (conflict) {
        errors.push(
          issue({
            field: `fields.${name}.${conflict.attribute}`,
            code: "inheritance_violation",
            expected: `${conflict.expected}, inherited from "${ancestor.owner}"`,
            actual: conflict.actual,
            hint: `A child type may sharpen an inherited field's description or tighten it to required, but not change its shape. Rename the property, or change "${ancestor.owner}" instead.`,
          }),
        );
      }
    }
  }

  const descendants =
    typeof obj.id === "string" && ctx.descendantsOf
      ? ctx.descendantsOf(obj.id)
      : [];
  if (fields) {
    validateDescendantShapes(fields, requiredNames, descendants, errors);
    validateDescendantLinks(
      obj.id,
      fields,
      requiredNames,
      ancestorFields,
      descendants,
      ctx,
      errors,
    );
  }

  const visibleFields = new Set<string>([
    ...(fields ? Object.keys(fields) : []),
    ...ancestorFields.keys(),
  ]);

  if (fields) {
    validateThumbnails(fields, ancestorFields, descendants, errors);
  }

  for (const name of requiredNames) {
    if (!visibleFields.has(name)) {
      errors.push(
        issue({
          field: "required",
          expected:
            "every required name to match a declared or inherited field",
          actual: `"${name}", which this type does not declare`,
          hint: `Add "${name}" to fields, or drop it from required.`,
        }),
      );
    }
  }

  validateRoles(obj, errors);
  validateDisplayHints(
    obj,
    visibleFields,
    thumbnailNames(fields, ancestorFields),
    errors,
  );
  validateLinkField(obj, fields, requiredNames, ancestorFields, errors);
  validateVersionPolicy(obj, errors);
  validateMergePolicy(obj, visibleFields, errors);
  validateCompatibleWith(
    obj,
    fields,
    requiredNames,
    ancestorFields,
    ctx,
    errors,
  );

  if (errors.length > 0) return { success: false, errors };

  const normalizedFields: Record<string, FieldDefinition> = {};
  for (const [name, def] of Object.entries(fields ?? {})) {
    normalizedFields[name] = normalizeFieldDefinition(
      asRecord(def) ?? { type: "string" },
      { required: requiredNames.has(name) },
    );
  }
  // A child may tighten an inherited optional field through the top-level
  // `required` array without restating its full definition. Materialize that
  // refinement so it survives registration instead of disappearing when the
  // normalized schema replaces the submitted shape.
  for (const name of requiredNames) {
    if (Object.hasOwn(normalizedFields, name)) continue;
    const inherited = ancestorFields.get(name)?.definition;
    if (inherited) {
      normalizedFields[name] = { ...inherited, required: true };
    }
  }

  const schema: TypeSchema = {
    id: obj.id as string,
    label: typeof obj.label === "string" ? obj.label : undefined,
    version: typeof obj.version === "number" ? obj.version : 0,
    fields: normalizedFields,
  };
  if (typeof obj.description === "string") schema.description = obj.description;
  if (parentId) schema.parent = parentId;
  if (Array.isArray(obj.roles) && obj.roles.length > 0) {
    // Sorted as well as deduplicated, so the stored order is canonical. The
    // register and update responses hand back what is stored, while the reads
    // hand back a resolved union that is sorted by construction; without this
    // the same type would come back in different orders from different
    // endpoints the day a second role exists, and nothing would fail.
    schema.roles = [...new Set(obj.roles as TypeRole[])].sort();
  }
  if (Array.isArray(obj.compatible_with)) {
    schema.compatible_with = obj.compatible_with as string[];
  } else if (typeof obj.compatible_with === "string") {
    schema.compatible_with = [obj.compatible_with];
  }
  const hints = asRecord(obj.display_hints);
  if (hints) {
    const dh: { title_field?: string; body_field?: string } = {};
    if (typeof hints.title_field === "string")
      dh.title_field = hints.title_field;
    if (typeof hints.body_field === "string") dh.body_field = hints.body_field;
    if (Object.keys(dh).length > 0) schema.display_hints = dh;
  }
  if (typeof obj.link_field === "string") schema.link_field = obj.link_field;
  const versionPolicy = asRecord(obj.version_policy);
  if (versionPolicy) {
    schema.version_policy = versionPolicy;
  }
  const mergePolicy = asRecord(obj.merge_policy);
  if (mergePolicy) {
    schema.merge_policy = mergePolicy;
  }

  return { success: true, data: schema };
}

// ---------------------------------------------------------------------------
// Optional blocks
// ---------------------------------------------------------------------------

/**
 * `roles` is a closed vocabulary rather than free text, because an edge
 * constrains on it. A role nobody recognizes would leave a type looking as
 * though it had declared something and every edge silently refusing it, which
 * is the failure this whole mechanism exists to remove.
 *
 * No bare-string shorthand: `compatible_with` accepts one for historical
 * reasons and every reader of that field pays for it. This one starts with a
 * single shape.
 */
function validateRoles(
  obj: Record<string, unknown>,
  errors: SchemaValidationIssue[],
): void {
  if (obj.roles === undefined) return;
  if (!Array.isArray(obj.roles)) {
    errors.push(
      issue({
        field: "roles",
        expected: `an array of roles (${TYPE_ROLES.join(", ")})`,
        actual: describe(obj.roles),
        hint: 'Write roles as ["container"], or omit it.',
      }),
    );
    return;
  }
  for (const role of obj.roles) {
    if (typeof role !== "string" || !TYPE_ROLE_SET.has(role)) {
      errors.push(
        issue({
          field: "roles",
          expected: `one of: ${TYPE_ROLES.join(", ")}`,
          actual: describe(role),
          hint: "Roles are a closed set; an edge constrains on them, so an unrecognized one would never match anything.",
        }),
      );
    }
  }
}

function isThumbnail(def: unknown): boolean {
  const raw = asRecord(def);
  return raw?.type === "thumbnail" || raw?.format === "thumbnail";
}

/** The thumbnail fields a type declares or inherits, by name. */
function thumbnailNames(
  fields: Record<string, unknown> | undefined,
  ancestorFields: ReadonlyMap<string, { definition: FieldDefinition }>,
): Set<string> {
  const names = new Set<string>();
  for (const [name, def] of Object.entries(fields ?? {})) {
    if (isThumbnail(def)) names.add(name);
  }
  for (const [name, { definition }] of ancestorFields) {
    if (definition.type === "thumbnail") names.add(name);
  }
  return names;
}

/**
 * The inheritance rule seen from the parent: a type may not declare a field
 * under a name a type inheriting from it already declares with another shape.
 * The child's registration checked it against the parent as the parent then
 * stood; this checks a change to the parent against the child as it stands,
 * so neither order leaves the child's items read by one shape and validated
 * by the other.
 */
function validateDescendantShapes(
  fields: Record<string, unknown>,
  requiredNames: ReadonlySet<string>,
  descendants: readonly TypeSchema[],
  errors: SchemaValidationIssue[],
): void {
  for (const [name, def] of Object.entries(fields)) {
    const raw = asRecord(def);
    if (!raw) continue;
    const own = normalizeFieldDefinition(raw, {
      required: requiredNames.has(name),
    });
    for (const child of descendants) {
      if (!Object.hasOwn(child.fields, name)) continue;
      const declared = child.fields[name];
      if (!declared) continue;
      const conflict = describeShapeConflict(declared, own);
      if (conflict) {
        errors.push(
          issue({
            field: `fields.${name}.${conflict.attribute}`,
            code: "inheritance_violation",
            expected: `the shape "${child.id}" already declares "${name}" with`,
            actual: `${conflict.expected} here, ${conflict.actual} in "${child.id}"`,
            hint: `Give "${name}" the shape "${child.id}" declares, rename it here, or change "${child.id}" first.`,
          }),
        );
      }
    }
  }
}

/**
 * A type carries at most one thumbnail, counting what it inherits and what
 * the types that inherit from it already declare, so a device reading "the
 * item's thumbnail" is never choosing between two.
 */
function validateThumbnails(
  fields: Record<string, unknown>,
  ancestorFields: ReadonlyMap<
    string,
    { owner: string; definition: FieldDefinition }
  >,
  descendants: readonly TypeSchema[],
  errors: SchemaValidationIssue[],
): void {
  const own = Object.keys(fields).filter((name) => isThumbnail(fields[name]));
  for (const name of own) {
    if ((ALWAYS_SEARCHED_FIELDS as readonly string[]).includes(name)) {
      errors.push(
        issue({
          field: `fields.${name}`,
          expected: `a thumbnail named other than ${ALWAYS_SEARCHED_FIELDS.join(", ")}`,
          actual: `a thumbnail named "${name}"`,
          hint: `Search indexes "${name}" whatever its type, which would make the image's base64 searchable. Name it "thumbnail".`,
        }),
      );
    }
  }
  const inherited = [...ancestorFields.entries()]
    .filter(
      ([name, { definition }]) =>
        definition.type === "thumbnail" && !own.includes(name),
    )
    .map(([name, { owner }]) => `"${name}" from "${owner}"`);
  const last = own.at(-1);
  if (last === undefined) return;
  const all = [...own.map((name) => `"${name}"`), ...inherited];
  if (all.length > 1) {
    errors.push(
      issue({
        field: `fields.${last}`,
        expected: "at most one thumbnail field, counting inherited ones",
        actual: `${String(all.length)}: ${all.join(", ")}`,
        hint: "Keep one thumbnail field.",
      }),
    );
    return;
  }
  // A type gaining a thumbnail its registered children already declare one
  // beside would leave each of them with two. A child declaring this one
  // under the same name redeclares it, which is not a second.
  const crowded = descendants.flatMap((child) =>
    Object.entries(child.fields)
      .filter(([name, def]) => def.type === "thumbnail" && name !== last)
      .map(([name]) => `"${name}" in "${child.id}"`),
  );
  if (crowded.length > 0) {
    errors.push(
      issue({
        field: `fields.${last}`,
        expected:
          "at most one thumbnail field in every type that inherits this one",
        actual: `a thumbnail beside ${crowded.join(", ")}`,
        hint: "Keep the thumbnail on one level of the hierarchy.",
      }),
    );
  }
}

function validateDisplayHints(
  obj: Record<string, unknown>,
  visibleFields: ReadonlySet<string>,
  thumbnails: ReadonlySet<string>,
  errors: SchemaValidationIssue[],
): void {
  if (obj.display_hints === undefined) return;
  const hints = asRecord(obj.display_hints);
  if (!hints) {
    errors.push(
      issue({
        field: "display_hints",
        expected: "an object, or nothing",
        actual: describe(obj.display_hints),
        hint: 'Write display_hints as { "title_field": "...", "body_field": "..." }.',
      }),
    );
    return;
  }
  for (const hintKey of ["title_field", "body_field"] as const) {
    const value = hints[hintKey];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors.push(
        issue({
          field: `display_hints.${hintKey}`,
          expected: "a string naming a field on this type",
          actual: describe(value),
          hint: `Point ${hintKey} at one of this type's fields, or omit it.`,
        }),
      );
      continue;
    }
    if (!visibleFields.has(value)) {
      errors.push(
        issue({
          field: `display_hints.${hintKey}`,
          expected: "a field this type declares or inherits",
          actual: `"${value}", which is neither`,
          hint: `Declare "${value}" in fields, or point ${hintKey} at an existing field.`,
        }),
      );
    } else if (thumbnails.has(value)) {
      // A title or a body is text a person reads and a search indexes; an
      // image's base64 is neither.
      errors.push(
        issue({
          field: `display_hints.${hintKey}`,
          expected: "a field that is not a thumbnail",
          actual: `"${value}", which is a thumbnail`,
          hint: `Point ${hintKey} at a text field, or omit it.`,
        }),
      );
    }
  }
}

function validateLinkField(
  obj: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
  requiredNames: ReadonlySet<string>,
  ancestorFields: ReadonlyMap<string, { definition: FieldDefinition }>,
  errors: SchemaValidationIssue[],
): void {
  if (obj.link_field === undefined) return;
  const name = obj.link_field;
  if (typeof name !== "string") {
    errors.push(
      issue({
        field: "link_field",
        expected: "a string naming a string field on this type",
        actual: describe(name),
        hint: "Point link_field at the field holding the vendor's own id, or omit it.",
      }),
    );
    return;
  }
  if (/["\\]/.test(name)) {
    // The index reads the field through a JSON path, where a `"` ends the
    // name and a `\` starts an escape.
    errors.push(
      issue({
        field: "link_field",
        expected: "a field whose name holds no double quote or backslash",
        actual: describe(name),
        hint: "Rename the field, or point link_field at another string field.",
      }),
    );
    return;
  }
  const definition = visibleDefinition(
    name,
    fields,
    requiredNames,
    ancestorFields,
  );
  if (!definition) {
    errors.push(
      issue({
        field: "link_field",
        expected: "a field this type declares or inherits",
        actual: `"${name}", which is neither`,
        hint: `Declare "${name}" in fields as a string, or point link_field at an existing one.`,
      }),
    );
  } else if (definition.type !== "string") {
    // A vendor's id is compared as it was sent, and only a plain string
    // is stored that way.
    errors.push(
      issue({
        field: "link_field",
        expected: "a field of type string",
        actual: `"${name}", which is of type ${definition.type}`,
        hint: `Point link_field at a string field, or declare "${name}" as one.`,
      }),
    );
  }
}

function visibleDefinition(
  name: string,
  fields: Record<string, unknown> | undefined,
  requiredNames: ReadonlySet<string>,
  ancestorFields: ReadonlyMap<string, { definition: FieldDefinition }>,
): FieldDefinition | undefined {
  const own = asRecord(
    fields !== undefined && Object.hasOwn(fields, name)
      ? fields[name]
      : undefined,
  );
  return own
    ? normalizeFieldDefinition(own, { required: requiredNames.has(name) })
    : ancestorFields.get(name)?.definition;
}

/** A change above a type is the other way its link could come to name no
 *  string field, which its own registration refuses. */
function validateDescendantLinks(
  top: unknown,
  fields: Record<string, unknown>,
  requiredNames: ReadonlySet<string>,
  ancestorFields: ReadonlyMap<string, { definition: FieldDefinition }>,
  descendants: readonly TypeSchema[],
  ctx: SchemaValidationContext,
  errors: SchemaValidationIssue[],
): void {
  for (const child of descendants) {
    const name = child.link_field;
    if (name === undefined || declaredBetween(child, top, name, ctx)) continue;
    const definition = visibleDefinition(
      name,
      fields,
      requiredNames,
      ancestorFields,
    );
    if (definition?.type === "string") continue;
    errors.push(
      issue({
        field: `fields.${name}`,
        expected: `a string field "${name}", which "${child.id}" names as its link_field`,
        actual: definition
          ? `"${name}" of type ${definition.type}`
          : `no field "${name}"`,
        hint: `Keep "${name}" a string field, or point the link_field of "${child.id}" elsewhere first.`,
      }),
    );
  }
}

function declaredBetween(
  child: TypeSchema,
  top: unknown,
  name: string,
  ctx: SchemaValidationContext,
): boolean {
  const seen = new Set<string>();
  let cursor: TypeSchema | undefined = child;
  while (cursor && cursor.id !== top && !seen.has(cursor.id)) {
    if (Object.hasOwn(cursor.fields, name)) return true;
    seen.add(cursor.id);
    cursor = cursor.parent ? ctx.resolveSchema(cursor.parent) : undefined;
  }
  return false;
}

function validateVersionPolicy(
  obj: Record<string, unknown>,
  errors: SchemaValidationIssue[],
): void {
  if (obj.version_policy === undefined) return;
  const vp = asRecord(obj.version_policy);
  if (!vp) {
    errors.push(
      issue({
        field: "version_policy",
        expected: "an object, or nothing",
        actual: describe(obj.version_policy),
        hint: "version_policy tunes per-item snapshot retention for this type.",
      }),
    );
    return;
  }
  for (const key of [
    "recent_days",
    "daily_snapshot_days",
    "weekly_snapshot_days",
    "max_versions",
  ]) {
    const value = vp[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errors.push(
        issue({
          field: `version_policy.${key}`,
          expected: "a positive integer",
          actual: describe(value),
          hint: `Omit ${key} to inherit the instance default.`,
        }),
      );
    }
  }
  // Windows are ages counted back from now, so a later window with a
  // smaller bound is empty.
  const windows = [
    "recent_days",
    "daily_snapshot_days",
    "weekly_snapshot_days",
  ] as const;
  let ahead: (typeof windows)[number] | undefined;
  let longest = 0;
  for (const key of windows) {
    const value = vp[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      continue;
    }
    if (ahead !== undefined && value < longest) {
      errors.push(
        issue({
          field: `version_policy.${key}`,
          expected: `at least ${ahead} (${String(longest)})`,
          actual: describe(value),
          hint: "The windows run recent_days, then daily_snapshot_days, then weekly_snapshot_days, each counted back from now.",
        }),
      );
    }
    if (value >= longest) {
      longest = value;
      ahead = key;
    }
  }
}

function validateMergePolicy(
  obj: Record<string, unknown>,
  visibleFields: ReadonlySet<string>,
  errors: SchemaValidationIssue[],
): void {
  if (obj.merge_policy === undefined) return;
  const mp = asRecord(obj.merge_policy);
  if (!mp) {
    errors.push(
      issue({
        field: "merge_policy",
        expected: "an object, or nothing",
        actual: describe(obj.merge_policy),
        hint: 'Write merge_policy as { "fields": { "body": "keep_both_copies" } }.',
      }),
    );
    return;
  }
  if (mp.fields !== undefined) {
    const mpFields = asRecord(mp.fields);
    if (!mpFields) {
      errors.push(
        issue({
          field: "merge_policy.fields",
          expected: "an object mapping field names to merge strategies",
          actual: describe(mp.fields),
          hint: `Strategies are: ${MERGE_STRATEGIES.join(", ")}.`,
        }),
      );
    } else {
      for (const [fieldName, strategy] of Object.entries(mpFields)) {
        if (
          typeof strategy !== "string" ||
          !MERGE_STRATEGIES.includes(strategy)
        ) {
          errors.push(
            issue({
              field: `merge_policy.fields.${fieldName}`,
              expected: `one of: ${MERGE_STRATEGIES.join(", ")}`,
              actual: describe(strategy),
              hint: "Pick keep_both_copies for user-authored long text; last_writer_wins otherwise.",
            }),
          );
          continue;
        }
        if (!visibleFields.has(fieldName)) {
          errors.push(
            issue({
              field: `merge_policy.fields.${fieldName}`,
              expected: "a field this type declares or inherits",
              actual: `"${fieldName}", which is neither`,
              hint: `Declare "${fieldName}" in fields, or drop the entry.`,
            }),
          );
        }
      }
    }
  }
  if (
    mp.default !== undefined &&
    (typeof mp.default !== "string" || !MERGE_STRATEGIES.includes(mp.default))
  ) {
    errors.push(
      issue({
        field: "merge_policy.default",
        expected: `one of: ${MERGE_STRATEGIES.join(", ")}`,
        actual: describe(mp.default),
        hint: "Omit default to fall back to last_writer_wins.",
      }),
    );
  }
}

function validateCompatibleWith(
  obj: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
  requiredNames: ReadonlySet<string>,
  ancestorFields: ReadonlyMap<
    string,
    { owner: string; definition: FieldDefinition }
  >,
  ctx: SchemaValidationContext,
  errors: SchemaValidationIssue[],
): void {
  if (obj.compatible_with === undefined) return;

  let targets: string[];
  if (Array.isArray(obj.compatible_with)) {
    const nonStrings = obj.compatible_with.filter(
      (t: unknown) => typeof t !== "string",
    );
    if (nonStrings.length > 0) {
      errors.push(
        issue({
          field: "compatible_with",
          expected: "every entry to be a type identifier string",
          actual: describe(obj.compatible_with),
          hint: 'Write compatible_with as ["core.note"].',
        }),
      );
      return;
    }
    targets = obj.compatible_with as string[];
  } else if (typeof obj.compatible_with === "string") {
    // A bare string is accepted as the single-target shorthand and normalized
    // to a one-element array, so a hand-written schema is not rejected on
    // punctuation alone.
    targets = [obj.compatible_with];
  } else {
    errors.push(
      issue({
        field: "compatible_with",
        expected: "an array of type identifiers, or nothing",
        actual: describe(obj.compatible_with),
        hint: 'Write compatible_with as ["core.note"].',
      }),
    );
    return;
  }

  const candidateFields = new Map<string, FieldDefinition>();
  for (const [name, inherited] of ancestorFields) {
    candidateFields.set(name, {
      ...inherited.definition,
      required:
        inherited.definition.required === true || requiredNames.has(name),
    });
  }
  for (const [name, raw] of Object.entries(fields ?? {})) {
    const record = asRecord(raw);
    if (!record) continue;
    candidateFields.set(
      name,
      normalizeFieldDefinition(record, {
        required: requiredNames.has(name),
      }),
    );
  }

  for (const target of targets) {
    if (!ctx.resolveSchema(target)) {
      errors.push(
        issue({
          field: `compatible_with.${target}`,
          code: "compatible_with_violation",
          expected: "a registered type identifier",
          actual: `"${target}", which is not registered`,
          hint: "Register the target type first, or drop the claim.",
        }),
      );
      continue;
    }

    const targetFields = collectAncestorFields(target, ctx);
    for (const [fieldName, targetEntry] of targetFields) {
      const targetField = targetEntry.definition;
      const candidate = candidateFields.get(fieldName);

      // An optional target field carries a weaker promise: a reader of the
      // target already copes with it being absent, so this type need not
      // declare it. What it may not do is declare the same name with a
      // different shape — the reader will read that field when it is present,
      // and an integer where it expects an enum is a mis-parse either way.
      if (targetField.required !== true) {
        if (!candidate) continue;
        const conflict = describeCompatibilityConflict(candidate, targetField);
        if (conflict) {
          errors.push(
            issue({
              field: `compatible_with.${target}.${fieldName}.${conflict.attribute}`,
              code: "compatible_with_violation",
              expected: `${conflict.expected}, matching "${target}"`,
              actual: conflict.actual,
              hint: `A reader of "${target}" reads "${fieldName}" whenever it is present and would mis-parse this one. Match its shape, rename this field, or drop the claim.`,
            }),
          );
        }
        continue;
      }

      if (!candidate) {
        errors.push(
          issue({
            field: `compatible_with.${target}.${fieldName}`,
            code: "compatible_with_violation",
            expected: `a "${fieldName}" field, required by "${target}"`,
            actual: "nothing",
            hint: `Declaring compatibility with "${target}" promises every field it requires. Add "${fieldName}", or drop the claim.`,
          }),
        );
        continue;
      }

      if (candidate.required !== true) {
        errors.push(
          issue({
            field: `compatible_with.${target}.${fieldName}.required`,
            code: "compatible_with_violation",
            expected: `"${fieldName}" to be required, matching "${target}"`,
            actual: `"${fieldName}" is optional`,
            hint: `A reader of "${target}" expects this field on every item. Mark it required, or drop the claim.`,
          }),
        );
      }

      const conflict = describeCompatibilityConflict(candidate, targetField);
      if (conflict) {
        errors.push(
          issue({
            field: `compatible_with.${target}.${fieldName}.${conflict.attribute}`,
            code: "compatible_with_violation",
            expected: `${conflict.expected}, matching "${target}"`,
            actual: conflict.actual,
            hint: `A reader of "${target}" would mis-parse this field. Match its shape, or drop the claim.`,
          }),
        );
      }
    }
  }
}

/**
 * Field types whose values are a strict subset of another type's, keyed by
 * the narrower one.
 *
 * Every entry is a containment fact about the values themselves, matching how
 * each type is compiled for write-time validation: `url`, `email`,
 * `datetime`, `date`, `thumbnail` and `enum` all hold strings, and every
 * `integer` is a `number`. Each relation is one-way — a reader expecting a URL that is
 * handed an arbitrary string has no such guarantee — which is why this is a
 * table rather than a symmetric comparison.
 */
const FIELD_TYPES_READABLE_AS: Partial<
  Record<FieldType, readonly FieldType[]>
> = {
  url: ["string"],
  email: ["string"],
  datetime: ["string"],
  date: ["string"],
  thumbnail: ["string"],
  enum: ["string"],
  integer: ["number"],
};

/** Whether a value valid under `candidate` is also valid under `target`. */
function fieldTypeIsReadableAs(
  candidate: FieldType,
  target: FieldType,
): boolean {
  if (candidate === target) return true;
  return FIELD_TYPES_READABLE_AS[candidate]?.includes(target) ?? false;
}

/**
 * The first way `candidate` would surprise a reader of `target`, or null.
 *
 * Reaches field declarations only. Two `object` fields — or two arrays of
 * them — pass whatever they contain, because a `FieldDefinition` has no
 * vocabulary for nested shape and inventing one here would be guesswork. The
 * limit is documented alongside the authoring rule rather than papered over.
 */
function describeCompatibilityConflict(
  candidate: FieldDefinition,
  target: FieldDefinition,
): { attribute: string; expected: string; actual: string } | null {
  if (!fieldTypeIsReadableAs(candidate.type, target.type)) {
    return {
      attribute: "type",
      expected: `type ${target.type}`,
      actual: `type ${candidate.type}`,
    };
  }

  // Only the annotation-only formats survive normalization, and they carry no
  // guarantee about values: nothing checks a `bcp47` field at write time, so a
  // plain `string` and a `bcp47` string hold the same set and no reader can be
  // mis-parsed by the difference. An omitted annotation therefore passes.
  // Two different annotations do not: that is the author stating a contra-
  // diction, which is worth refusing even though neither is enforced.
  if (
    target.format !== undefined &&
    candidate.format !== undefined &&
    candidate.format !== target.format
  ) {
    return {
      attribute: "format",
      expected: `format ${target.format}`,
      actual: `format ${describe(candidate.format)}`,
    };
  }

  if (target.type === "array" && candidate.items_type !== target.items_type) {
    return {
      attribute: "items_type",
      expected: `items_type ${describe(target.items_type)}`,
      actual: `items_type ${describe(candidate.items_type)}`,
    };
  }

  if (target.type === "enum") {
    const targetValues = new Set(target.enum_values ?? []);
    const incompatibleValue = (candidate.enum_values ?? []).find(
      (value) => !targetValues.has(value),
    );
    if (incompatibleValue !== undefined) {
      return {
        attribute: "enum_values",
        expected: `enum values drawn from ${describe(target.enum_values)}`,
        actual: `the additional value ${describe(incompatibleValue)}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Edge type validation
// ---------------------------------------------------------------------------

export const EDGE_CARDINALITIES: readonly EdgeCardinality[] = [
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
];

export const EDGE_CASCADES: readonly EdgeCascade[] = [
  "cascade",
  "orphan",
  "block",
];

const EDGE_CARDINALITY_SET: ReadonlySet<string> = new Set(EDGE_CARDINALITIES);
const EDGE_CASCADE_SET: ReadonlySet<string> = new Set(EDGE_CASCADES);

/** Kebab-case, matching every shipped edge id (`parent-of`, `in-thread`). */
const EDGE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type EdgeTypeSchemaValidationResult =
  | { success: true; data: EdgeTypeSchema }
  | { success: false; errors: SchemaValidationIssue[] };

/**
 * Validates and normalizes an edge type schema. On success the returned
 * `data` is the canonical `EdgeTypeSchema` — constraints defaulted to `["*"]`,
 * cascade defaulted to `"orphan"`, property fields normalized through the
 * same field model item properties use. The build-time codegen and the
 * in-tree schema check both call this, so a malformed edge JSON fails the
 * build instead of reaching the registry as a blind cast.
 */
export function validateEdgeTypeSchema(
  input: unknown,
): EdgeTypeSchemaValidationResult {
  const obj = asRecord(input);
  if (!obj) {
    return {
      success: false,
      errors: [
        issue({
          field: "(root)",
          expected: "an edge type schema object",
          actual: describe(input),
          hint: 'Submit an object like { "id": "in-thread", "cardinality": "many-to-one" }.',
        }),
      ],
    };
  }

  const errors: SchemaValidationIssue[] = [];

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    errors.push(
      issue({
        field: "id",
        expected: "a non-empty kebab-case identifier",
        actual: describe(obj.id),
        hint: 'Give the edge type an id such as "in-thread".',
      }),
    );
  } else if (!EDGE_ID_PATTERN.test(obj.id)) {
    errors.push(
      issue({
        field: "id",
        expected: "lowercase kebab-case (letters, digits, single hyphens)",
        actual: describe(obj.id),
        hint: "Edge ids use hyphens, never dots, slashes, or capitals.",
      }),
    );
  }

  for (const key of ["label", "description"] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") {
      errors.push(
        issue({
          field: key,
          expected: "a string",
          actual: describe(obj[key]),
          hint: `Write ${key} as prose, or omit it.`,
        }),
      );
    }
  }

  if (
    obj.written_at !== undefined &&
    obj.written_at !== "source" &&
    obj.written_at !== "target"
  ) {
    errors.push(
      issue({
        field: "written_at",
        expected: 'one of: "source", "target"',
        actual: describe(obj.written_at),
        hint: "Name the end whose file writes the edge, or omit it for the source.",
      }),
    );
  } else if (obj.written_at === "target" && obj.reverse_name === undefined) {
    errors.push(
      issue({
        field: "written_at",
        expected: "a reverse_name beside written_at: target",
        actual: "no reverse_name",
        hint: "The target's file writes the edge under the name read from the target.",
      }),
    );
  }

  if (obj.reverse_name !== undefined) {
    if (
      typeof obj.reverse_name !== "string" ||
      !EDGE_ID_PATTERN.test(obj.reverse_name)
    ) {
      errors.push(
        issue({
          field: "reverse_name",
          expected: "lowercase kebab-case (letters, digits, single hyphens)",
          actual: describe(obj.reverse_name),
          hint: 'Name the edge as read from its target, such as "child-of".',
        }),
      );
    } else if (obj.reverse_name === obj.id) {
      errors.push(
        issue({
          field: "reverse_name",
          expected: "a name other than the edge type's own id",
          actual: describe(obj.reverse_name),
          hint: "A reverse name is the other end's name for the same edge.",
        }),
      );
    }
  }

  if (
    typeof obj.cardinality !== "string" ||
    !EDGE_CARDINALITY_SET.has(obj.cardinality)
  ) {
    errors.push(
      issue({
        field: "cardinality",
        expected: `one of: ${EDGE_CARDINALITIES.join(", ")}`,
        actual: describe(obj.cardinality),
        hint: "Every edge type declares its cardinality explicitly.",
      }),
    );
  }

  for (const side of [
    "source_type_constraints",
    "target_type_constraints",
  ] as const) {
    const value = obj[side];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      errors.push(
        issue({
          field: side,
          expected:
            'a non-empty array of type identifiers, role constraints, or ["*"]',
          actual: describe(value),
          hint: `Use ["*"] to allow every type, "role:container" to allow every type declaring that role, or list the permitted type identifiers.`,
        }),
      );
      continue;
    }
    // A `role:` entry naming a role nobody defines matches no type at all, so
    // the edge would refuse every endpoint while reading as though it allowed
    // a family of them. Caught here rather than at edge-creation time, where
    // it surfaces as a puzzling refusal on somebody else's write.
    for (const entry of value as string[]) {
      if (isRoleConstraint(entry) && roleFromConstraint(entry) === undefined) {
        errors.push(
          issue({
            field: side,
            expected: `a known role: ${TYPE_ROLES.map((r) => `${ROLE_CONSTRAINT_PREFIX}${r}`).join(", ")}`,
            actual: `"${entry}"`,
            hint: "Roles are a closed set. An unknown one would match no type and silently refuse every endpoint.",
          }),
        );
      }
    }
  }

  if (
    obj.cascade_on_delete !== undefined &&
    (typeof obj.cascade_on_delete !== "string" ||
      !EDGE_CASCADE_SET.has(obj.cascade_on_delete))
  ) {
    errors.push(
      issue({
        field: "cascade_on_delete",
        expected: `one of: ${EDGE_CASCADES.join(", ")}`,
        actual: describe(obj.cascade_on_delete),
        hint: 'Omit it for the default, "orphan".',
      }),
    );
  }

  const propertySchema: Record<string, FieldDefinition> = {};
  if (obj.property_schema !== undefined) {
    const props = asRecord(obj.property_schema);
    if (!props) {
      errors.push(
        issue({
          field: "property_schema",
          expected: "an object mapping property names to field definitions",
          actual: describe(obj.property_schema),
          hint: 'Write property_schema as { "position": { "type": "number" } }, or omit it.',
        }),
      );
    } else {
      // Edge properties reuse the item-field model, so they go through the
      // same shape checks and the same normalizer as item fields.
      for (const [name, def] of Object.entries(props)) {
        const before = errors.length;
        validateFieldShape(name, def, errors);
        // An edge carries no thumbnail: nothing reads one from an edge, and
        // a value nothing reads is a value nothing checks.
        if (isThumbnail(def)) {
          errors.push(
            issue({
              field: `property_schema.${name}`,
              expected: "a property type an edge can carry",
              actual: "a thumbnail",
              hint: "Put the thumbnail on the item the edge points at.",
            }),
          );
        }
        if (errors.length === before) {
          const record = asRecord(def);
          if (record) {
            propertySchema[name] = normalizeFieldDefinition(record);
          }
        }
      }
    }
  }

  if (errors.length > 0) return { success: false, errors };

  const data: EdgeTypeSchema = {
    id: obj.id as string,
    cardinality: obj.cardinality as EdgeCardinality,
    source_type_constraints: (obj.source_type_constraints as
      string[] | undefined) ?? ["*"],
    target_type_constraints: (obj.target_type_constraints as
      string[] | undefined) ?? ["*"],
    cascade_on_delete:
      (obj.cascade_on_delete as EdgeCascade | undefined) ?? "orphan",
    property_schema: propertySchema,
    written_at: (obj.written_at as EdgeWrittenAt | undefined) ?? "source",
  };
  if (typeof obj.label === "string") data.label = obj.label;
  if (typeof obj.description === "string") data.description = obj.description;
  if (typeof obj.reverse_name === "string") {
    data.reverse_name = obj.reverse_name;
  }

  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Keys no validator reads
// ---------------------------------------------------------------------------

/**
 * Every top-level key `validateTypeSchema` reads to accept. Checked against
 * `TypeSchema` in both directions, so a key added to the type without being
 * listed here fails to compile rather than being refused in every file that
 * uses it. `required` is the authoring form the validator folds into the
 * fields, and so is read without being a key of the result. The keys it
 * reads only to refuse are `REFUSED_TYPE_SCHEMA_KEYS`, and
 * `unread-keys.test.ts` holds the two lists together to what it reads.
 */
export const TYPE_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys({
    id: true,
    parent: true,
    label: true,
    description: true,
    version: true,
    fields: true,
    roles: true,
    display_hints: true,
    link_field: true,
    version_policy: true,
    merge_policy: true,
    compatible_with: true,
  } satisfies Record<keyof TypeSchema, true>),
  "required",
]);

/** Every top-level key `validateEdgeTypeSchema` reads, held the same way. */
export const EDGE_TYPE_SCHEMA_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    id: true,
    label: true,
    description: true,
    cardinality: true,
    source_type_constraints: true,
    target_type_constraints: true,
    cascade_on_delete: true,
    property_schema: true,
    reverse_name: true,
    written_at: true,
  } satisfies Record<keyof EdgeTypeSchema, true>),
);

/**
 * One issue per top-level key the validator for this kind of schema does
 * not read.
 *
 * The validators ignore such a key, and the registration routes call them,
 * so refusing it there would change what the wire accepts. An in-tree file
 * is held tighter because it is the format people copy: a key nothing reads
 * says something nothing enforces, and a copy carries it on as if it did.
 * `scripts/validate.ts` asks this of every in-tree file.
 */
export function unreadTopLevelKeys(
  input: unknown,
  kind: "type" | "edge",
): SchemaValidationIssue[] {
  const obj = asRecord(input);
  if (!obj) return [];
  const read = kind === "type" ? TYPE_SCHEMA_KEYS : EDGE_TYPE_SCHEMA_KEYS;
  // A refused key is the validator's to report, and reporting it here too
  // would name one fault twice.
  const refused = kind === "type" ? REFUSED_TYPE_SCHEMA_KEYS : [];
  return Object.keys(obj)
    .filter((key) => !read.has(key) && !refused.includes(key))
    .map((key) =>
      issue({
        field: key,
        expected: `only the keys the ${kind} schema validator reads: ${[...read].sort().join(", ")}`,
        actual: `an unread key "${key}"`,
        hint: "Remove it: nothing reads it, so it changes nothing about the type.",
      }),
    );
}
