import { z } from "zod";
import { ALL_TYPES, ALL_SYSTEM_TYPES } from "@withmarfa/types";
import type {
  DisplayHints,
  FieldDefinition,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  TypeSchema,
  VersionPolicy,
} from "@withmarfa/types";
import type { EnforcementSettings, TenantConfig } from "./types.js";
import { isValidTypeIdentifier } from "./validation.js";

// Re-export schema-shape types and ALL_TYPES so consumers of @withmarfa/shared
// don't need to reach into @withmarfa/types directly.
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

// Core and system types are global — shipped with @withmarfa/types and shared
// by every tenant. This map is read-only after construction. System types are
// tracked separately via SYSTEM_TYPE_IDS so consumers (search exclude,
// lifecycle override) can recognise them without re-classifying namespaces.
const _coreRegistry = new Map<string, TypeSchema>(
  [...ALL_TYPES, ...ALL_SYSTEM_TYPES].map((schema) => [schema.id, schema]),
);

/**
 * Custom types are tenant-scoped. The outer key is the owning tenant's id;
 * each tenant gets its own inner id→schema map. A custom type registered by
 * tenant A is therefore invisible to tenant B's lookups — the isolation that
 * keeps one tenant's type vocabulary out of another's, so one tenant can't
 * instantiate (or validate against) a type it never defined. The sentinel
 * `NULL_TENANT` key holds custom types with no tenant (single-tenant
 * self-hosts, platform-registered types) so the keys-mode flow is unaffected.
 */
const _customByTenant = new Map<string, Map<string, TypeSchema>>();

// Sentinel for custom types with no owning tenant — single-tenant self-hosts
// and platform-registered types. An empty string can't collide with a real
// tenant id (ids are non-empty), so it's a safe bucket key.
const NULL_TENANT = "";

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? NULL_TENANT;
}

/**
 * Resolves a type schema for a given tenant: core/system types resolve
 * globally; custom types resolve only within their owning tenant. A lookup
 * with no `tenantId` sees core/system plus the null-tenant bucket
 * (single-tenant self-hosts), never another tenant's custom types. This is the
 * single resolution primitive every tenant-aware helper below threads through,
 * including the inheritance-chain walks (a custom type's parent may itself be a
 * custom type in the same tenant).
 */
function resolveSchema(
  typeId: string,
  tenantId?: string | null,
): TypeSchema | undefined {
  const core = _coreRegistry.get(typeId);
  if (core) return core;
  return _customByTenant.get(tenantKey(tenantId))?.get(typeId);
}

/** The set of type IDs in the platform `system.*` registry. These are tracked separately so consumers can apply the lifecycle and search restrictions that apply to system types. */
export const SYSTEM_TYPE_IDS: ReadonlySet<string> = new Set(
  ALL_SYSTEM_TYPES.map((schema) => schema.id),
);

/**
 * First-class field names on the `Item` wire shape. Custom-type schemas may
 * not declare `fields.<name>` for any name in this set — doing so would let a
 * row carry two values under the same key (the first-class field and the
 * shadowing property), with no way to tell which is authoritative. Enforced
 * at `validateTypeSchema` time so type authors rename before any data is
 * written; mirrored at build time by the in-tree types generator.
 *
 * Source of truth: the `Item` interface in `types.ts`. A freshness test
 * (`type-registry.test.ts`) derives the set from a typed `Item` literal and
 * fails loudly if this constant drifts.
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

// ---------------------------------------------------------------------------
// Schema-enforcement levers
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

/**
 * The core type registry — the global core + system type schemas by
 * identifier. Custom (tenant-scoped) types are NOT exposed here; consumers
 * that need a tenant's full set call `listTypes(tenantId)`, and lookups go
 * through `getTypeSchema(id, tenantId)`. The OAuth scope allow-list and consent
 * descriptions read this for the static core-scope enumeration.
 */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = _coreRegistry;

/**
 * Resolves a type schema for a given tenant. Core/system types resolve
 * globally; custom types resolve only within their owning tenant. A lookup
 * with no `tenantId` sees core/system plus the null-tenant bucket
 * (single-tenant self-hosts), never another tenant's custom types.
 */
export function getTypeSchema(
  typeId: string,
  tenantId?: string | null,
): TypeSchema | undefined {
  return resolveSchema(typeId, tenantId);
}

/**
 * Lists every type visible to a tenant: the global core + system set plus that
 * tenant's own custom types. With no `tenantId`, returns core/system plus the
 * null-tenant bucket — never another tenant's custom types.
 */
export function listTypes(tenantId?: string | null): TypeSchema[] {
  const custom = _customByTenant.get(tenantKey(tenantId));
  if (!custom) return [..._coreRegistry.values()];
  return [..._coreRegistry.values(), ...custom.values()];
}

/**
 * The five-tier namespace classification. The first segment of a type
 * identifier determines its tier; reserved roots (`core`, `system`, `app`,
 * `user`, `marfa`) carry platform-defined semantics, anything else is a
 * publisher handle.
 */
export type NamespaceTier =
  | "core"
  | "system"
  | "app"
  | "user"
  | "publisher"
  | "marfa";

const RESERVED_ROOTS: ReadonlySet<string> = new Set([
  "core",
  "system",
  "app",
  "user",
  "marfa",
]);

/** Returns true if the candidate is a reserved root prefix. */
export function isReservedRoot(candidate: string): boolean {
  return RESERVED_ROOTS.has(candidate);
}

/**
 * Classifies a type identifier into one of the five tiers (plus the
 * `marfa` reserved-but-internal root). Falls back to `"publisher"` for any
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
  if (root === "marfa") return "marfa";
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

/**
 * Registers a custom type schema into the tenant's overlay and clears that
 * tenant's cached Zod schema for the id. Core/system types are never
 * registered here (they live in the global map); callers filter them out
 * before calling. `tenantId` is the owning tenant — omit it only for the
 * null-tenant bucket (single-tenant self-host / platform).
 */
export function registerTypeSchema(
  schema: TypeSchema,
  tenantId?: string | null,
): void {
  const key = tenantKey(tenantId);
  let bucket = _customByTenant.get(key);
  if (!bucket) {
    bucket = new Map<string, TypeSchema>();
    _customByTenant.set(key, bucket);
  }
  bucket.set(schema.id, schema);
  // The Zod cache is keyed per tenant, so clearing only this tenant's entry is
  // both sufficient and necessary — two tenants may hold different schemas
  // under the same id.
  zodSchemaCache.delete(zodCacheKey(schema.id, tenantId));
  zodSchemaStrictCache.delete(zodCacheKey(schema.id, tenantId));
}

/**
 * Removes a custom type schema from the tenant's overlay and clears its cached
 * Zod schema for that tenant.
 */
export function unregisterTypeSchema(
  id: string,
  tenantId?: string | null,
): void {
  _customByTenant.get(tenantKey(tenantId))?.delete(id);
  zodSchemaCache.delete(zodCacheKey(id, tenantId));
  zodSchemaStrictCache.delete(zodCacheKey(id, tenantId));
}

/**
 * Returns the fully resolved fields for a type, including inherited parent
 * fields and universal fields (attachments, links).
 *
 * Subtype fields override parent fields of the same name.
 */
export function getResolvedFields(
  typeId: string,
  tenantId?: string | null,
): Record<string, FieldDefinition> | undefined {
  const schema = resolveSchema(typeId, tenantId);
  if (!schema) return undefined;

  const fields: Record<string, FieldDefinition> = { ...UNIVERSAL_FIELDS };

  // Collect the inheritance chain (parent first, then child). A custom type's
  // parent may itself be a custom type, so resolve each ancestor through the
  // same tenant scope.
  const chain: TypeSchema[] = [];
  let current: TypeSchema | undefined = schema;
  while (current) {
    chain.unshift(current);
    current = current.parent
      ? resolveSchema(current.parent, tenantId)
      : undefined;
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
 * Respects the `searchable: false` opt-out — fields explicitly flagged as
 * non-searchable are excluded, so both FTS backends (SQLite `items_fts.extra`
 * and PG `search_vector`) skip them. Fields without the flag default to
 * searchable.
 */
export function getSearchableStringFields(
  typeId: string,
  tenantId?: string | null,
): string[] {
  const fields = getResolvedFields(typeId, tenantId);
  if (!fields) return [];
  return Object.entries(fields)
    .filter(
      ([key, def]) =>
        def.type === "string" &&
        !CORE_SEARCH_FIELDS.has(key) &&
        def.searchable !== false,
    )
    .map(([key]) => key);
}

/**
 * Returns true when `typeId.fieldName` is a string field whose definition
 * explicitly opts out of FTS via `searchable: false`. The search indexer
 * consults this for the four core fields (title, body, description, name) —
 * `getSearchableStringFields` only covers the long tail. Fields that don't
 * exist on the type, or non-string fields, return false (default-searchable).
 */
export function isFieldSearchableExcluded(
  typeId: string,
  fieldName: string,
  tenantId?: string | null,
): boolean {
  const fields = getResolvedFields(typeId, tenantId);
  if (!fields) return false;
  const def = fields[fieldName];
  if (def?.type !== "string") return false;
  return def.searchable === false;
}

/**
 * Returns true if typeId is a subtype of (or equal to) parentId. Resolves the
 * inheritance chain within the given tenant so custom types (whose ancestors
 * may also be custom) classify correctly; with no `tenantId` only core/system
 * types resolve.
 */
export function isSubtypeOf(
  typeId: string,
  parentId: string,
  tenantId?: string | null,
): boolean {
  if (typeId === parentId) return true;
  let current = resolveSchema(typeId, tenantId);
  while (current?.parent) {
    if (current.parent === parentId) return true;
    current = resolveSchema(current.parent, tenantId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation — Zod schema generation from field definitions
// ---------------------------------------------------------------------------

// Postgres TEXT columns cannot store the NUL codepoint (U+0000) — the byte
// reaches the driver and throws, surfacing as an unhandled 500 on otherwise
// well-formed client input. Reject it at the validation layer so every string
// field is covered at once and the caller gets a clean 400 instead. NUL is the
// only codepoint Postgres TEXT outright refuses; every other control character
// (tab, newline, carriage return) and all higher Unicode (emoji, RTL marks,
// accents) round-trip unchanged, so the guard is scoped to U+0000 alone.
const noNullByte = (schema: z.ZodString): z.ZodType =>
  schema.refine((value) => !value.includes("\u0000"), {
    message: "Must not contain a null byte (U+0000)",
  });

function fieldToZod(field: FieldDefinition): z.ZodType {
  let schema: z.ZodType;

  switch (field.type) {
    case "string":
      schema = noNullByte(z.string());
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
      schema = noNullByte(z.string());
      break;
    case "date":
      schema = noNullByte(z.string());
      break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        schema = z.enum(field.enum_values as [string, ...string[]]);
      } else {
        schema = noNullByte(z.string());
      }
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    case "object":
      schema = z.record(z.string(), z.unknown());
      break;
  }

  // Optional fields treat an explicit JSON `null` as "unset". Serializers
  // (ORMs, mappers, many language defaults, LLM-generated payloads) routinely
  // emit `null` for an absent value rather than omitting the key; rejecting it
  // as a type error makes every such caller pre-prune nulls. Accept `null` on
  // an optional field and coerce it to `undefined` so it drops out of the
  // validated output and never persists. Required fields keep the strict type
  // check, so a required field sent as `null` still rejects.
  if (field.required) return schema;
  return schema
    .nullish()
    .transform((value) => (value === null ? undefined : value));
}

// Cache generated Zod schemas to avoid re-creation on every validation call.
// Two caches: one for the default permissive shape, one for strict — strict
// mode flips z.looseObject (passes unknown properties) to z.strictObject
// (rejects them). The key folds in the tenant: two tenants may register
// different schemas under the same type id, so a tenant-blind cache would
// serve one tenant's shape to another. Core/system types collapse to a single
// shared entry under the null-tenant key (they're identical for everyone).
const zodSchemaCache = new Map<string, z.ZodType>();
const zodSchemaStrictCache = new Map<string, z.ZodType>();

function zodCacheKey(typeId: string, tenantId?: string | null): string {
  // Core/system types are global — cache them once under the null-tenant key
  // regardless of who looked them up, so every tenant shares the same entry.
  const scope = _coreRegistry.has(typeId) ? NULL_TENANT : tenantKey(tenantId);
  return `${scope} ${typeId}`;
}

function getZodSchema(
  typeId: string,
  options?: { strict?: boolean; tenantId?: string | null },
): z.ZodType | undefined {
  const strict = options?.strict === true;
  const cache = strict ? zodSchemaStrictCache : zodSchemaCache;
  const key = zodCacheKey(typeId, options?.tenantId);
  const cached = cache.get(key);
  if (cached) return cached;

  const fields = getResolvedFields(typeId, options?.tenantId);
  if (!fields) return undefined;

  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = fieldToZod(field);
  }

  const schema = strict ? z.strictObject(shape) : z.looseObject(shape);
  cache.set(key, schema);
  return schema;
}

/** Validation result for property validation. */
export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; errors: { field: string; message: string }[] };

/**
 * Validates item properties against the type schema.
 * Standard fields are validated; custom fields are passed through unless
 * `options.strict` is true, in which case unknown properties are rejected.
 */
export function validateProperties(
  typeId: string,
  properties: Record<string, unknown>,
  options?: { strict?: boolean; tenantId?: string | null },
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

/**
 * Returns a copy of `properties` with explicit `null` values dropped for every
 * key that is not a required field on the type. Mirrors the create-path
 * validation semantics (null on an optional field means "unset") for the
 * update paths, which merge into an existing row rather than re-validating from
 * scratch. A `null` on a required field is preserved so downstream validation
 * still rejects it; unknown / custom keys are treated as optional (their null
 * is dropped) to match the passthrough behavior of `validateProperties`.
 * Unknown types are left untouched — there is no schema to classify against.
 */
export function coerceNullProperties(
  typeId: string,
  properties: Record<string, unknown>,
  tenantId?: string | null,
): Record<string, unknown> {
  const fields = getResolvedFields(typeId, tenantId);
  if (!fields) return properties;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null && fields[key]?.required !== true) continue;
    out[key] = value;
  }
  return out;
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
 * Lifecycle override for `system.*` types: bounded to `active | revoked`,
 * where `revoked` is terminal. Archived / trashed do not apply to
 * operational platform records.
 */
export const SYSTEM_TYPE_TRANSITIONS: Readonly<Record<ItemState, ItemState[]>> =
  {
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
 * redeclares a field already defined by an ancestor (the inheritance
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

export function validateTypeSchema(
  input: unknown,
  tenantId?: string | null,
): TypeSchemaValidationResult {
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

    // Shadow rule — custom-type fields may not collide with first-class
    // `Item` wire fields. Letting `properties.<name>` reuse a top-level
    // name means two values coexist under one key (the first-class column
    // and the shadowing property), with nothing telling downstream
    // consumers which is authoritative. Reject at registration so the
    // type author renames before any data is written. Runs regardless of
    // whether a parent is declared.
    for (const fieldName of Object.keys(fields)) {
      if (RESERVED_ITEM_FIELDS.has(fieldName)) {
        errors.push({
          field: `fields.${fieldName}`,
          message: `Field "${fieldName}" shadows a first-class Item field. Custom-type schemas may not redefine first-class field names — set the corresponding Item field directly, or pick a more specific name for this property.`,
          code: "property_shadows_field",
        });
      }
    }

    // Inheritance rule — a child type may not redefine a field declared by
    // any ancestor in its parent chain. New-field addition remains allowed.
    if (typeof obj.parent === "string" && obj.parent.length > 0) {
      const ancestorFieldOwners = new Map<string, string>();
      let cursor: string | undefined = obj.parent;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor = resolveSchema(cursor, tenantId);
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

  // Lifecycle is universal — reject state-machine declarations.
  for (const forbiddenKey of ["states", "default_state", "transitions"]) {
    if (forbiddenKey in obj) {
      errors.push({
        field: forbiddenKey,
        message: `Schemas must not declare \`${forbiddenKey}\`; lifecycle is universal (metadata-layer).`,
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
          const ancestor = resolveSchema(cursor, tenantId);
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
          const ancestor = resolveSchema(cursor, tenantId);
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

  // compatible_with — structural-superset check at registration. Every
  // required field on the target type must be present here with a matching
  // shape. Only enforced after the rest of the schema is well-formed; errors
  // are emitted as `compatible_with_violation` so callers can disambiguate.
  if (obj.compatible_with !== undefined) {
    if (typeof obj.compatible_with !== "string") {
      errors.push({
        field: "compatible_with",
        message: "Must be a type identifier string",
      });
    } else {
      const target = resolveSchema(obj.compatible_with, tenantId);
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
    schema.version_policy = obj.version_policy;
  }
  if (
    typeof obj.merge_policy === "object" &&
    obj.merge_policy !== null &&
    !Array.isArray(obj.merge_policy)
  ) {
    schema.merge_policy = obj.merge_policy;
  }

  return { success: true, data: schema };
}
