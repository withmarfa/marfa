// The single validator for type schemas, shared by both authoring paths: the
// build-time codegen that reads `core/*.json` and `connectors/*.json`, and the
// runtime `POST /types` endpoint. Both call `validateTypeSchema` and both get
// the same normalization, the same rules, and the same errors — a schema that
// is legal in-tree is legal over the wire, byte for byte.
//
// Dependency-free on purpose. `@withmarfa/shared` depends on this package, so
// nothing here may reach back into shared; registry access is injected through
// `SchemaValidationContext` instead.

import type {
  FieldDefinition,
  FieldFormat,
  FieldType,
  TypeSchema,
} from "./schema-types.js";

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
];

export const FIELD_FORMATS: readonly FieldFormat[] = [
  "url",
  "email",
  "datetime",
  "date",
  "bcp47",
  "iso3166",
];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set<string>(FIELD_TYPES);
const FIELD_FORMAT_SET: ReadonlySet<string> = new Set<string>(FIELD_FORMATS);

/**
 * Formats that have a first-class `FieldType` of the same name. A field
 * declaring one is normalized to the equivalent `type` so there is exactly one
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
  };

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
  "tenant_id",
  "properties",
  "created_at",
  "updated_at",
  "timestamp",
  "source",
  "source_id",
  "version",
  "schema_version",
  "device",
  "capture_latitude",
  "capture_longitude",
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
   * and `compatible_with` checks. The runtime binds this to the tenant-scoped
   * registry lookup; the codegen binds it to the in-tree schema map.
   */
  resolveSchema: (typeId: string) => TypeSchema | undefined;
  /**
   * Validates a type identifier against the namespace grammar. Injected
   * because the grammar lives in `@withmarfa/shared`, which depends on this
   * package. Omit to skip the identifier check (the codegen path, where the
   * filename already pins the identifier).
   */
  isValidTypeIdentifier?: (value: string) => boolean;
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
  const type = (collapsed ?? raw.type) as FieldType;

  const out: FieldDefinition = { type };
  if (typeof raw.description === "string" && raw.description.length > 0) {
    out.description = raw.description;
  }
  const required = options?.required ?? raw.required === true;
  if (required) out.required = true;
  if (Array.isArray(raw.enum_values)) {
    out.enum_values = raw.enum_values as string[];
  }
  if (typeof raw.items_type === "string") out.items_type = raw.items_type;
  // Only the annotation-only formats survive; the rest are now carried by
  // `type` and repeating them would give the same field two spellings.
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
    } else if (
      !FORMAT_TO_FIELD_TYPE[declaredFormat as FieldFormat] &&
      fd.type !== "string"
    ) {
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
      obj.version < 1)
  ) {
    errors.push(
      issue({
        field: "version",
        expected: "a positive integer",
        actual: describe(obj.version),
        hint: "Versions are integers starting at 1. Omit the field to default to 1.",
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

  // Lifecycle is universal and metadata-layer; a per-type state machine has no
  // effect and would mislead whoever wrote it.
  for (const forbiddenKey of ["states", "default_state", "transitions"]) {
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

  const visibleFields = new Set<string>([
    ...(fields ? Object.keys(fields) : []),
    ...ancestorFields.keys(),
  ]);

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

  validateDisplayHints(obj, visibleFields, errors);
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
    if (normalizedFields[name]) continue;
    const inherited = ancestorFields.get(name)?.definition;
    if (inherited) {
      normalizedFields[name] = { ...inherited, required: true };
    }
  }

  const schema: TypeSchema = {
    id: obj.id as string,
    label: typeof obj.label === "string" ? obj.label : undefined,
    version: typeof obj.version === "number" ? obj.version : 1,
    fields: normalizedFields,
  };
  if (typeof obj.description === "string") schema.description = obj.description;
  if (parentId) schema.parent = parentId;
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

function validateDisplayHints(
  obj: Record<string, unknown>,
  visibleFields: ReadonlySet<string>,
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
    }
  }
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
 * `datetime`, `date` and `enum` all hold strings, and every `integer` is a
 * `number`. Each relation is one-way — a reader expecting a URL that is
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
