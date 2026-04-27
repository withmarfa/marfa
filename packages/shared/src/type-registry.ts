import { z } from "zod";
import { ALL_TYPES, ALL_SYSTEM_TYPES } from "@mymehq/types";
import type {
  DisplayHints,
  FieldDefinition,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  TypeSchema,
  VersionPolicy,
} from "@mymehq/types";
import type { EnforcementSettings, TenantConfig } from "./types.js";
import { isValidTypeIdentifier } from "./validation.js";

// Re-export schema-shape types and ALL_TYPES so consumers of @mymehq/shared
// don't need to reach into @mymehq/types directly.
export type {
  DisplayHints,
  FieldDefinition,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  TypeSchema,
  VersionPolicy,
};
export { ALL_TYPES, ALL_SYSTEM_TYPES };

const MERGE_STRATEGIES: ReadonlySet<MergeStrategy> = new Set([
  "last_writer_wins",
  "keep_both_copies",
]);

// ---------------------------------------------------------------------------
// Universal fields (available on every type)
// ---------------------------------------------------------------------------

const UNIVERSAL_FIELDS: Record<string, FieldDefinition> = {
  attachments: { type: "array", items_type: "object" },
  links: { type: "array", items_type: "string" },
};

// Internal mutable map — exposed as ReadonlyMap to prevent accidental mutation.
// Holds both the canonical core.* types and the platform-internal system.*
// set; the system set is also tracked separately via SYSTEM_TYPE_IDS so
// downstream consumers (search default-exclude, lifecycle override, tier
// rejection) can recognize them without re-classifying namespaces.
const _registry = new Map<string, TypeSchema>(
  [...ALL_TYPES, ...ALL_SYSTEM_TYPES].map((schema) => [schema.id, schema]),
);

/** The set of type IDs in the platform `system.*` registry (TSC42 §4). */
export const SYSTEM_TYPE_IDS: ReadonlySet<string> = new Set(
  ALL_SYSTEM_TYPES.map((schema) => schema.id),
);

// ---------------------------------------------------------------------------
// Schema-enforcement levers (TSC42 §5)
// ---------------------------------------------------------------------------

/**
 * Computes the effective enforcement settings for a given (tenant config,
 * credential) pair. Per-credential override wins where set, falling back to
 * the tenant default. All three levers are independently overridable —
 * setting `strict_mode` on the credential does not clear the tenant
 * `source_allowlist`.
 */
export function resolveEnforcement(
  tenant: TenantConfig | null | undefined,
  credential: { enforcement_override?: EnforcementSettings } | null | undefined,
): EnforcementSettings {
  const tenantSettings = tenant?.enforcement ?? {};
  const override = credential?.enforcement_override ?? {};
  return {
    strict_mode: override.strict_mode ?? tenantSettings.strict_mode,
    source_allowlist:
      override.source_allowlist ?? tenantSettings.source_allowlist,
    source_filter: override.source_filter ?? tenantSettings.source_filter,
  };
}

/** Returns true when the type is configured for strict-object validation. */
export function isTypeInStrictMode(
  enforcement: EnforcementSettings,
  typeId: string,
): boolean {
  return enforcement.strict_mode?.types.includes(typeId) ?? false;
}

/**
 * Returns the source allow-list for the given type, or null when the lever
 * is off for this type. Callers reject writes whose credential `source` is
 * not present in the returned array.
 */
export function getSourceAllowlist(
  enforcement: EnforcementSettings,
  typeId: string,
): string[] | null {
  const list = enforcement.source_allowlist;
  if (!list) return null;
  if (!list.types.includes(typeId)) return null;
  return list.sources;
}

/**
 * Returns the source-filter list for the given type, or null when the lever
 * is off. Callers narrow read results to items whose source is in the array.
 */
export function getSourceFilter(
  enforcement: EnforcementSettings,
  typeId: string,
): string[] | null {
  const list = enforcement.source_filter;
  if (!list) return null;
  if (!list.types.includes(typeId)) return null;
  return list.sources;
}

/** The type registry — all registered type schemas indexed by type identifier. */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = _registry;

/** Returns the type schema for the given type identifier, or undefined. */
export function getTypeSchema(typeId: string): TypeSchema | undefined {
  return _registry.get(typeId);
}

/**
 * The five-tier namespace classification (TSC42 §3). The first segment of a
 * type identifier determines its tier; reserved roots (`core`, `system`,
 * `app`, `user`, `myme`) carry platform-defined semantics, anything else is a
 * publisher handle.
 */
export type NamespaceTier =
  | "core"
  | "system"
  | "app"
  | "user"
  | "publisher"
  | "myme";

const RESERVED_ROOTS: ReadonlySet<string> = new Set([
  "core",
  "system",
  "app",
  "user",
  "myme",
]);

/** Returns true if the candidate is a reserved root prefix. */
export function isReservedRoot(candidate: string): boolean {
  return RESERVED_ROOTS.has(candidate);
}

/**
 * Classifies a type identifier into one of the five tiers (plus the
 * `myme` reserved-but-internal root). Falls back to `"publisher"` for any
 * non-reserved first segment — the namespace grammar disambiguates by
 * structure: `<publisher>.<type>` is two segments, `<reserved>.<...>` follows
 * the tier-specific shape.
 */
export function classifyNamespace(id: string): NamespaceTier {
  const root = id.split(".", 1)[0] ?? "";
  if (root === "core") return "core";
  if (root === "system") return "system";
  if (root === "app") return "app";
  if (root === "user") return "user";
  if (root === "myme") return "myme";
  return "publisher";
}

/** Returns true if the type identifier belongs to the core namespace. */
export function isCoreType(id: string): boolean {
  return classifyNamespace(id) === "core";
}

/** Returns true if the type identifier belongs to the system namespace. */
export function isSystemType(id: string): boolean {
  return classifyNamespace(id) === "system";
}

/** Returns true if the type identifier belongs to the app namespace. */
export function isAppType(id: string): boolean {
  return classifyNamespace(id) === "app";
}

/** Returns true if the type identifier belongs to the user namespace. */
export function isUserType(id: string): boolean {
  return classifyNamespace(id) === "user";
}

/** Returns true if the type identifier is a publisher-published type. */
export function isPublisherType(id: string): boolean {
  return classifyNamespace(id) === "publisher";
}

/** Registers a type schema into the in-memory registry. Clears the zod cache. */
export function registerTypeSchema(schema: TypeSchema): void {
  _registry.set(schema.id, schema);
  zodSchemaCache.delete(schema.id);
  zodSchemaStrictCache.delete(schema.id);
}

/** Removes a type schema from the in-memory registry. Clears the zod cache. */
export function unregisterTypeSchema(id: string): void {
  _registry.delete(id);
  zodSchemaCache.delete(id);
  zodSchemaStrictCache.delete(id);
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
// Two caches: one for the default permissive shape, one for strict — strict
// mode flips z.looseObject (passes unknown properties) to z.strictObject
// (rejects them) per TSC42 §5.
const zodSchemaCache = new Map<string, z.ZodType>();
const zodSchemaStrictCache = new Map<string, z.ZodType>();

function getZodSchema(
  typeId: string,
  options?: { strict?: boolean },
): z.ZodType | undefined {
  const strict = options?.strict === true;
  const cache = strict ? zodSchemaStrictCache : zodSchemaCache;
  const cached = cache.get(typeId);
  if (cached) return cached;

  const fields = getResolvedFields(typeId);
  if (!fields) return undefined;

  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = fieldToZod(field);
  }

  const schema = strict ? z.strictObject(shape) : z.looseObject(shape);
  cache.set(typeId, schema);
  return schema;
}

/** Validation result for property validation. */
export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; errors: { field: string; message: string }[] };

/**
 * Validates item properties against the type schema.
 * Standard fields are validated; custom fields are passed through unless
 * `options.strict` is true, in which case unknown properties are rejected
 * (TSC42 §5 — strict-mode lever).
 */
export function validateProperties(
  typeId: string,
  properties: Record<string, unknown>,
  options?: { strict?: boolean },
): ValidationResult {
  const schema = getZodSchema(typeId, options);
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

/**
 * Allowed transitions keyed by current state, for the canonical (non-system)
 * lifecycle graph. `revoked` is terminal for non-system types and unreachable
 * via these transitions; the `system.*` set declares its own override (see
 * SYSTEM_TYPE_TRANSITIONS) where `active → revoked` is the lifecycle.
 */
export const SYSTEM_TRANSITIONS: Readonly<Record<ItemState, ItemState[]>> = {
  active: ["archived", "trashed"],
  archived: ["active", "trashed"],
  trashed: ["active"],
  revoked: [],
};

/**
 * Lifecycle override for `system.*` types (TSC42 §4): bounded to
 * `active | revoked`, where `revoked` is terminal. Archived / trashed do not
 * apply to operational platform records.
 */
export const SYSTEM_TYPE_TRANSITIONS: Readonly<
  Record<ItemState, ItemState[]>
> = {
  active: ["revoked"],
  archived: [],
  trashed: [],
  revoked: [],
};

const SYSTEM_STATES: ReadonlySet<ItemState> = new Set([
  "active",
  "archived",
  "trashed",
  "revoked",
]);

/**
 * Validates whether a state transition is allowed. Universal — types do not
 * declare their own state machines, so the typeId is only kept for API
 * parity and potential future use. It is NOT used to reject transitions on
 * custom (registered) types: the server-side item-store enforces type
 * existence at create time, so by the time `validateTransition` is called
 * the type is already known, and custom types share the same state graph
 * as core types.
 */
export function validateTransition(
  typeId: string,
  currentState: ItemState,
  nextState: ItemState,
): string | null {
  if (!SYSTEM_STATES.has(currentState)) {
    return `Invalid current state "${currentState}"`;
  }

  if (!SYSTEM_STATES.has(nextState)) {
    return `Invalid target state "${nextState}"`;
  }

  // `system.*` items use the bounded active → revoked lifecycle. All other
  // types follow the canonical three-state graph.
  const transitions = SYSTEM_TYPE_IDS.has(typeId)
    ? SYSTEM_TYPE_TRANSITIONS
    : SYSTEM_TRANSITIONS;
  const allowed = transitions[currentState];
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
/** Result of validating a type schema.
 *
 * Each error optionally carries a `code` discriminator. The most specific
 * code today is `"inheritance_violation"`, used when a child type
 * redeclares a field already defined by an ancestor (V0 spec inheritance
 * rule). Route handlers consult this to surface the specific
 * `INHERITANCE_VIOLATION` error code in the API response rather than the
 * generic `INVALID_SCHEMA`.
 */
export type TypeSchemaValidationResult =
  | { success: true; data: TypeSchema }
  | {
      success: false;
      errors: { field: string; message: string; code?: string }[];
    };

export function validateTypeSchema(input: unknown): TypeSchemaValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ field: "_root", message: "Expected an object" }],
    };
  }

  const obj = input as Record<string, unknown>;
  const errors: { field: string; message: string; code?: string }[] = [];

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
            code: "inheritance_violation",
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
      // display_hints.{title_field,body_field} may point at fields declared on
      // any ancestor — a child of core.note that wants to surface the inherited
      // `title` field as its title hint is a legitimate use case. Collect the
      // full visible field set by walking the parent chain via the registry.
      const visibleFields = new Set(Object.keys(fieldMap));
      if (typeof obj.parent === "string" && obj.parent.length > 0) {
        const seen = new Set<string>();
        let cursor: string | undefined = obj.parent;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          const ancestor = TYPE_REGISTRY.get(cursor);
          if (!ancestor) break;
          for (const fieldName of Object.keys(ancestor.fields)) {
            visibleFields.add(fieldName);
          }
          cursor = ancestor.parent;
        }
      }
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
        if (!visibleFields.has(value)) {
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

  // merge_policy (optional)
  if (obj.merge_policy !== undefined) {
    if (
      typeof obj.merge_policy !== "object" ||
      obj.merge_policy === null ||
      Array.isArray(obj.merge_policy)
    ) {
      errors.push({
        field: "merge_policy",
        message: "Must be an object",
      });
    } else {
      const mp = obj.merge_policy as Record<string, unknown>;
      const fieldMap =
        typeof obj.fields === "object" && obj.fields !== null
          ? (obj.fields as Record<string, unknown>)
          : {};
      // merge_policy.fields may reference fields declared on any ancestor —
      // overriding an inherited field's strategy is a legitimate use case
      // (e.g. a child of core.note that wants body to be last-writer-wins
      // instead of the parent's keep-both). Collect the full visible field
      // set by walking the parent chain via the registry.
      const visibleFields = new Set(Object.keys(fieldMap));
      if (typeof obj.parent === "string" && obj.parent.length > 0) {
        const seen = new Set<string>();
        let cursor: string | undefined = obj.parent;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          const ancestor = TYPE_REGISTRY.get(cursor);
          if (!ancestor) break;
          for (const fieldName of Object.keys(ancestor.fields)) {
            visibleFields.add(fieldName);
          }
          cursor = ancestor.parent;
        }
      }
      if (mp.fields !== undefined) {
        if (
          typeof mp.fields !== "object" ||
          mp.fields === null ||
          Array.isArray(mp.fields)
        ) {
          errors.push({
            field: "merge_policy.fields",
            message:
              "Must be an object mapping field names to merge strategies",
          });
        } else {
          for (const [fieldName, strategy] of Object.entries(
            mp.fields as Record<string, unknown>,
          )) {
            if (typeof strategy !== "string") {
              errors.push({
                field: `merge_policy.fields.${fieldName}`,
                message: "Strategy must be a string",
              });
              continue;
            }
            if (!MERGE_STRATEGIES.has(strategy as MergeStrategy)) {
              errors.push({
                field: `merge_policy.fields.${fieldName}`,
                message: `Strategy must be one of: ${Array.from(MERGE_STRATEGIES).join(", ")}`,
              });
              continue;
            }
            if (!visibleFields.has(fieldName)) {
              errors.push({
                field: `merge_policy.fields.${fieldName}`,
                message: `References field "${fieldName}" that does not exist on this type`,
              });
            }
          }
        }
      }
      if (mp.default !== undefined) {
        if (
          typeof mp.default !== "string" ||
          !MERGE_STRATEGIES.has(mp.default as MergeStrategy)
        ) {
          errors.push({
            field: "merge_policy.default",
            message: `Must be one of: ${Array.from(MERGE_STRATEGIES).join(", ")}`,
          });
        }
      }
    }
  }

  // compatible_with (TSC42 §3) — structural-superset check at registration.
  // Only enforced after the rest of the schema is well-formed; errors here
  // are emitted as `compatible_with_violation` so callers can disambiguate.
  if (obj.compatible_with !== undefined) {
    if (typeof obj.compatible_with !== "string") {
      errors.push({
        field: "compatible_with",
        message: "Must be a type identifier string",
      });
    } else {
      const target = TYPE_REGISTRY.get(obj.compatible_with);
      if (!target) {
        errors.push({
          field: "compatible_with",
          message: `Target type "${obj.compatible_with}" does not exist`,
          code: "compatible_with_violation",
        });
      } else if (
        typeof obj.fields === "object" &&
        obj.fields !== null &&
        !Array.isArray(obj.fields)
      ) {
        const declaredFields = obj.fields as Record<string, unknown>;
        for (const [fieldName, targetField] of Object.entries(target.fields)) {
          const required = targetField.required === true;
          if (!required) continue;
          const own = declaredFields[fieldName];
          if (own === undefined) {
            errors.push({
              field: `compatible_with.${fieldName}`,
              message: `Missing required field "${fieldName}" from compatible target "${obj.compatible_with}"`,
              code: "compatible_with_violation",
            });
            continue;
          }
          if (typeof own !== "object" || own === null) continue;
          const ownDef = own as Record<string, unknown>;
          if (ownDef.type !== targetField.type) {
            errors.push({
              field: `compatible_with.${fieldName}`,
              message: `Field "${fieldName}" type "${String(ownDef.type)}" does not match target "${targetField.type}"`,
              code: "compatible_with_violation",
            });
          }
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
  if (typeof obj.compatible_with === "string") {
    schema.compatible_with = obj.compatible_with;
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
  if (
    typeof obj.merge_policy === "object" &&
    obj.merge_policy !== null &&
    !Array.isArray(obj.merge_policy)
  ) {
    schema.merge_policy = obj.merge_policy as MergePolicy;
  }

  return { success: true, data: schema };
}
