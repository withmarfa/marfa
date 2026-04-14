import { z } from "zod";
import { ALL_TYPES } from "@mymehq/types";
import type {
  FieldDefinition,
  FieldType,
  ItemState,
  TypeSchema,
  VersionPolicy,
} from "@mymehq/types";
import { isValidTypeIdentifier } from "./validation.js";

// Re-export schema-shape types and ALL_TYPES so consumers of @mymehq/shared
// don't need to reach into @mymehq/types directly.
export type {
  FieldDefinition,
  FieldType,
  ItemState,
  TypeSchema,
  VersionPolicy,
};
export { ALL_TYPES };

// ---------------------------------------------------------------------------
// Universal fields (available on every type)
// ---------------------------------------------------------------------------

const UNIVERSAL_FIELDS: Record<string, FieldDefinition> = {
  attachments: { type: "array", items_type: "object" },
  links: { type: "array", items_type: "string" },
};

// Internal mutable map — exposed as ReadonlyMap to prevent accidental mutation.
const _registry = new Map<string, TypeSchema>(
  ALL_TYPES.map((schema) => [schema.id, schema]),
);

/** The type registry — all registered type schemas indexed by type identifier. */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = _registry;

/** Returns the type schema for the given type identifier, or undefined. */
export function getTypeSchema(typeId: string): TypeSchema | undefined {
  return _registry.get(typeId);
}

/** Returns true if the type identifier belongs to the core namespace. */
export function isCoreType(id: string): boolean {
  return id.startsWith("core.");
}

/** Registers a type schema into the in-memory registry. Clears the zod cache. */
export function registerTypeSchema(schema: TypeSchema): void {
  _registry.set(schema.id, schema);
  zodSchemaCache.delete(schema.id);
}

/** Removes a type schema from the in-memory registry. Clears the zod cache. */
export function unregisterTypeSchema(id: string): void {
  _registry.delete(id);
  zodSchemaCache.delete(id);
}

/**
 * Returns the fully resolved fields for a type, including inherited parent
 * fields and universal fields (attachments, links).
 *
 * Subtype fields override parent fields of the same name.
 */
export function getResolvedFields(
  typeId: string,
): Record<string, FieldDefinition> | undefined {
  const schema = TYPE_REGISTRY.get(typeId);
  if (!schema) return undefined;

  const fields: Record<string, FieldDefinition> = { ...UNIVERSAL_FIELDS };

  // Collect the inheritance chain (parent first, then child)
  const chain: TypeSchema[] = [];
  let current: TypeSchema | undefined = schema;
  while (current) {
    chain.unshift(current);
    current = current.parent ? TYPE_REGISTRY.get(current.parent) : undefined;
  }

  // Merge fields — later entries override earlier ones
  for (const ancestor of chain) {
    Object.assign(fields, ancestor.fields);
  }

  return fields;
}

const CORE_SEARCH_FIELDS = new Set(["title", "body", "description", "name"]);

/**
 * Returns the names of string-typed fields for a type that are not already
 * covered by the 4 core search fields. Used to index custom type properties.
 */
export function getSearchableStringFields(typeId: string): string[] {
  const fields = getResolvedFields(typeId);
  if (!fields) return [];
  return Object.entries(fields)
    .filter(
      ([key, def]) => def.type === "string" && !CORE_SEARCH_FIELDS.has(key),
    )
    .map(([key]) => key);
}

/** Returns true if typeId is a subtype of (or equal to) parentId. */
export function isSubtypeOf(typeId: string, parentId: string): boolean {
  if (typeId === parentId) return true;
  let current = TYPE_REGISTRY.get(typeId);
  while (current?.parent) {
    if (current.parent === parentId) return true;
    current = TYPE_REGISTRY.get(current.parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation — Zod schema generation from field definitions
// ---------------------------------------------------------------------------

function fieldToZod(field: FieldDefinition): z.ZodType {
  let schema: z.ZodType;

  switch (field.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "url":
      schema = z.url();
      break;
    case "email":
      schema = z.email();
      break;
    case "datetime":
      schema = z.string();
      break;
    case "date":
      schema = z.string();
      break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        schema = z.enum(field.enum_values as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    case "object":
      schema = z.record(z.string(), z.unknown());
      break;
  }

  return field.required ? schema : schema.optional();
}

// Cache generated Zod schemas to avoid re-creation on every validation call.
const zodSchemaCache = new Map<string, z.ZodType>();

function getZodSchema(typeId: string): z.ZodType | undefined {
  const cached = zodSchemaCache.get(typeId);
  if (cached) return cached;

  const fields = getResolvedFields(typeId);
  if (!fields) return undefined;

  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = fieldToZod(field);
  }

  const schema = z.looseObject(shape);
  zodSchemaCache.set(typeId, schema);
  return schema;
}

/** Validation result for property validation. */
export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; errors: { field: string; message: string }[] };

/**
 * Validates item properties against the type schema.
 * Standard fields are validated; custom fields are passed through.
 */
export function validateProperties(
  typeId: string,
  properties: Record<string, unknown>,
): ValidationResult {
  const schema = getZodSchema(typeId);
  if (!schema) {
    return {
      success: false,
      errors: [{ field: "_type", message: `Unknown type: ${typeId}` }],
    };
  }

  const result = schema.safeParse(properties);
  if (result.success) {
    return {
      success: true,
      data: result.data as Record<string, unknown>,
    };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "_root",
    message: issue.message,
  }));
  return { success: false, errors };
}

// ---------------------------------------------------------------------------
// Metadata-layer lifecycle — universal across every type
// ---------------------------------------------------------------------------

/** Default state for a newly-created item. */
export const SYSTEM_DEFAULT_STATE: ItemState = "active";

/** Allowed transitions keyed by current state. */
export const SYSTEM_TRANSITIONS: Readonly<Record<ItemState, ItemState[]>> = {
  active: ["archived", "trashed"],
  archived: ["active", "trashed"],
  trashed: ["active"],
};

const SYSTEM_STATES: ReadonlySet<ItemState> = new Set([
  "active",
  "archived",
  "trashed",
]);

/**
 * Validates whether a state transition is allowed. Universal — types do not
 * declare their own state machines. The typeId argument is kept for API
 * compatibility and to distinguish unknown-type from invalid-transition errors.
 */
export function validateTransition(
  typeId: string,
  currentState: ItemState,
  nextState: ItemState,
): string | null {
  if (!TYPE_REGISTRY.has(typeId)) {
    return `Unknown type: ${typeId}`;
  }

  if (!SYSTEM_STATES.has(currentState)) {
    return `Invalid current state "${currentState}"`;
  }

  if (!SYSTEM_STATES.has(nextState)) {
    return `Invalid target state "${nextState}"`;
  }

  const allowed = SYSTEM_TRANSITIONS[currentState];
  if (!allowed.includes(nextState)) {
    return `Transition from "${currentState}" to "${nextState}" is not allowed`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Type schema validation — validates the shape of a TypeSchema object
// ---------------------------------------------------------------------------

/**
 * Validates whether an input object is a valid TypeSchema.
 * Returns a ValidationResult with either the parsed schema or field errors.
 */
/** Result of validating a type schema. */
export type TypeSchemaValidationResult =
  | { success: true; data: TypeSchema }
  | { success: false; errors: { field: string; message: string }[] };

export function validateTypeSchema(input: unknown): TypeSchemaValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ field: "_root", message: "Expected an object" }],
    };
  }

  const obj = input as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];

  // id
  if (typeof obj.id !== "string" || !isValidTypeIdentifier(obj.id)) {
    errors.push({
      field: "id",
      message: "Required valid type identifier (dot-notation, e.g. acme.deal)",
    });
  }

  // label (optional — defaults to type id)
  if (obj.label !== undefined && typeof obj.label !== "string") {
    errors.push({ field: "label", message: "Must be a string" });
  }

  // version (optional — defaults to 1)
  if (obj.version !== undefined) {
    if (
      typeof obj.version !== "number" ||
      !Number.isInteger(obj.version) ||
      obj.version < 1
    ) {
      errors.push({ field: "version", message: "Must be a positive integer" });
    }
  }

  // fields
  if (typeof obj.fields !== "object" || obj.fields === null) {
    errors.push({ field: "fields", message: "Required object" });
  } else {
    const fields = obj.fields as Record<string, unknown>;

    // Inheritance rule — a child type may not redefine a field declared by
    // any ancestor in its parent chain. New-field addition remains allowed.
    if (typeof obj.parent === "string" && obj.parent.length > 0) {
      const ancestorFieldOwners = new Map<string, string>();
      let cursor: string | undefined = obj.parent;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor = TYPE_REGISTRY.get(cursor);
        if (!ancestor) break;
        for (const ancestorFieldName of Object.keys(ancestor.fields)) {
          if (!ancestorFieldOwners.has(ancestorFieldName)) {
            ancestorFieldOwners.set(ancestorFieldName, cursor);
          }
        }
        cursor = ancestor.parent;
      }
      for (const fieldName of Object.keys(fields)) {
        const owner = ancestorFieldOwners.get(fieldName);
        if (owner) {
          errors.push({
            field: `fields.${fieldName}`,
            message: `Field "${fieldName}" is already declared by ancestor "${owner}"; child types may not redefine ancestor fields.`,
          });
        }
      }
    }

    for (const [name, def] of Object.entries(fields)) {
      if (typeof def !== "object" || def === null) {
        errors.push({
          field: `fields.${name}`,
          message: "Field definition must be an object",
        });
        continue;
      }
      const fd = def as Record<string, unknown>;
      if (typeof fd.type !== "string" || fd.type.length === 0) {
        errors.push({
          field: `fields.${name}.type`,
          message: "Field type is required and must be a non-empty string",
        });
      }
      if (fd.type === "enum") {
        if (!Array.isArray(fd.enum_values)) {
          errors.push({
            field: `fields.${name}.enum_values`,
            message: "Enum fields require an enum_values array",
          });
        } else if (
          !fd.enum_values.every((v: unknown) => typeof v === "string")
        ) {
          errors.push({
            field: `fields.${name}.enum_values`,
            message: "Enum values must be strings",
          });
        }
      }
    }
  }

  // Lifecycle is universal in V0 — reject stale state-machine declarations.
  for (const legacyKey of ["states", "default_state", "transitions"]) {
    if (legacyKey in obj) {
      errors.push({
        field: legacyKey,
        message: `Schemas no longer declare \`${legacyKey}\`; lifecycle is universal (metadata-layer).`,
      });
    }
  }

  // display_hints (optional)
  if (obj.display_hints !== undefined) {
    if (
      typeof obj.display_hints !== "object" ||
      obj.display_hints === null ||
      Array.isArray(obj.display_hints)
    ) {
      errors.push({ field: "display_hints", message: "Must be an object" });
    } else {
      const hints = obj.display_hints as Record<string, unknown>;
      const fieldMap =
        typeof obj.fields === "object" && obj.fields !== null
          ? (obj.fields as Record<string, unknown>)
          : {};
      for (const hintKey of ["title_field", "body_field"]) {
        const value = hints[hintKey];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          errors.push({
            field: `display_hints.${hintKey}`,
            message: "Must be a string naming an existing field",
          });
          continue;
        }
        if (!(value in fieldMap)) {
          errors.push({
            field: `display_hints.${hintKey}`,
            message: `References field "${value}" that does not exist on this type`,
          });
        }
      }
    }
  }

  // version_policy (optional)
  if (obj.version_policy !== undefined) {
    if (
      typeof obj.version_policy !== "object" ||
      obj.version_policy === null ||
      Array.isArray(obj.version_policy)
    ) {
      errors.push({
        field: "version_policy",
        message: "Must be an object",
      });
    } else {
      const vp = obj.version_policy as Record<string, unknown>;
      const vpFields = [
        "recent_days",
        "daily_snapshot_days",
        "weekly_snapshot_days",
        "max_versions",
      ];
      for (const f of vpFields) {
        if (
          vp[f] !== undefined &&
          (typeof vp[f] !== "number" || !Number.isInteger(vp[f]) || vp[f] < 1)
        ) {
          errors.push({
            field: `version_policy.${f}`,
            message: "Must be a positive integer",
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const schema: TypeSchema = {
    id: obj.id as string,
    label: typeof obj.label === "string" ? obj.label : undefined,
    version: typeof obj.version === "number" ? obj.version : 1,
    fields: obj.fields as Record<string, FieldDefinition>,
  };
  if (typeof obj.description === "string") {
    schema.description = obj.description;
  }
  if (typeof obj.parent === "string") {
    schema.parent = obj.parent;
  }
  if (
    typeof obj.display_hints === "object" &&
    obj.display_hints !== null &&
    !Array.isArray(obj.display_hints)
  ) {
    const hints = obj.display_hints as Record<string, unknown>;
    const dh: { title_field?: string; body_field?: string } = {};
    if (typeof hints.title_field === "string")
      dh.title_field = hints.title_field;
    if (typeof hints.body_field === "string") dh.body_field = hints.body_field;
    if (Object.keys(dh).length > 0) {
      schema.display_hints = dh;
    }
  }
  if (
    typeof obj.version_policy === "object" &&
    obj.version_policy !== null &&
    !Array.isArray(obj.version_policy)
  ) {
    schema.version_policy = obj.version_policy as VersionPolicy;
  }

  return { success: true, data: schema };
}
