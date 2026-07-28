import { z } from "zod";
import {
  ALL_TYPES,
  ALL_CONNECTOR_TYPES,
  ALL_SYSTEM_TYPES,
  RESERVED_ITEM_FIELDS,
  validateTypeSchema as validateTypeSchemaShape,
} from "@withmarfa/types";
import type {
  DisplayHints,
  FieldDefinition,
  FieldFormat,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  SchemaValidationIssue,
  TypeSchema,
  TypeSchemaValidationResult,
  VersionPolicy,
} from "@withmarfa/types";
import type { EnforcementSettings, TenantConfig } from "./types.js";
import { isValidTypeIdentifier } from "./validation.js";

// Re-export schema-shape types and the shipped registries so consumers of
// @withmarfa/shared don't need to reach into @withmarfa/types directly.
export type {
  DisplayHints,
  FieldDefinition,
  FieldFormat,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  SchemaValidationIssue,
  TypeSchema,
  TypeSchemaValidationResult,
  VersionPolicy,
};
export { ALL_TYPES, ALL_CONNECTOR_TYPES, ALL_SYSTEM_TYPES };

// ---------------------------------------------------------------------------
// Universal fields (available on every type)
// ---------------------------------------------------------------------------

const UNIVERSAL_FIELDS: Record<string, FieldDefinition> = {
  attachments: { type: "array", items_type: "object" },
  links: { type: "array", items_type: "string" },
};

// The platform-shipped types are global — bundled with @withmarfa/types and
// resolvable by every tenant. This map is read-only after construction. Three
// families feed it and each stays identifiable afterwards: `ALL_TYPES` is the
// core set, `ALL_CONNECTOR_TYPES` is the vendor-shaped set a connector writes
// into, and `ALL_SYSTEM_TYPES` is the platform-internal set. They resolve
// identically — the split describes provenance so a catalog can say what a
// tenant is actually looking at, not a difference in how lookups behave.
const _coreRegistry = new Map<string, TypeSchema>(
  [...ALL_TYPES, ...ALL_CONNECTOR_TYPES, ...ALL_SYSTEM_TYPES].map((schema) => [
    schema.id,
    schema,
  ]),
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
 * The set of type IDs shipped as connector types: one vendor's payload shape,
 * present so a connector has somewhere faithful to write. They carry no
 * behavioral restrictions — the split from the core set is a provenance
 * distinction, so a catalog can tell a tenant which types are the shared
 * vocabulary and which exist because a specific upstream service does.
 */
export const CONNECTOR_TYPE_IDS: ReadonlySet<string> = new Set(
  ALL_CONNECTOR_TYPES.map((schema) => schema.id),
);

/**
 * First-class field names on the `Item` wire shape. Re-exported from
 * `@withmarfa/types`, where the canonical list lives so the build-time and
 * runtime checks read one constant rather than two copies that drift.
 *
 * Source of truth for the *contents* is still the `Item` interface in
 * `types.ts`: a freshness test (`type-registry.test.ts`) derives the set from
 * a typed `Item` literal and fails loudly if the constant falls behind.
 */
export { RESERVED_ITEM_FIELDS };

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
 * Returns the source-filter list configured for exactly this type, or null
 * when the lever does not list it.
 *
 * This answers "which sources are approved for this identifier", which is a
 * question about configuration. It is deliberately NOT how a read narrows its
 * results: a list read must decide the lever from each row's own type, or a
 * caller switches the control off by broadening the query until it no longer
 * names the filtered type. The read predicate lives in the storage layer.
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

// Hard bound on inheritance-chain depth for the hot-path walks below
// (`getResolvedFields`, `isSubtypeOf`). The registration path
// (`validateTypeSchema`, `routes/types.ts`) rejects cycles before a schema
// enters the in-memory registry, so a chain exceeding this bound means a cycle
// or pathological depth slipped past those guards. Throw a clear error rather
// than loop forever — these walks run per-write and per-edge-check, so an
// unbounded loop here would hang the request. The bound is generous: real type
// hierarchies are a handful of levels deep.
const MAX_INHERITANCE_DEPTH = 100;

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
  // same tenant scope. The `seen` set guards against a cycle that somehow
  // reached the registry — without it a cyclic `parent` chain loops forever.
  const chain: TypeSchema[] = [];
  const seen = new Set<string>();
  let current: TypeSchema | undefined = schema;
  while (current) {
    if (seen.has(current.id) || seen.size >= MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Inheritance cycle or excessive depth detected resolving fields for type "${typeId}" (at "${current.id}")`,
      );
    }
    seen.add(current.id);
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
  // The `seen` set guards against a cycle that somehow reached the registry —
  // without it a cyclic `parent` chain loops forever on this per-edge-check
  // hot path. See MAX_INHERITANCE_DEPTH.
  const seen = new Set<string>();
  let current = resolveSchema(typeId, tenantId);
  while (current?.parent) {
    if (seen.has(current.id) || seen.size >= MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Inheritance cycle or excessive depth detected classifying type "${typeId}" (at "${current.id}")`,
      );
    }
    seen.add(current.id);
    if (current.parent === parentId) return true;
    current = resolveSchema(current.parent, tenantId);
  }
  return false;
}

/**
 * Every type in the tenant's vocabulary whose declared `parent` chain reaches
 * `rootId`, excluding `rootId` itself and excluding anything already covered by
 * a name-prefix match on `<rootId>.`.
 *
 * The identifier and the declared parent are two different hierarchies and
 * nothing keeps them in agreement: `acme.annotated_note` may legally declare
 * `core.note` as its parent, and registration accepts it. A subtree matcher
 * built on the name alone therefore answers a query about notes without the
 * annotated ones in it — no error, just a short answer. This is the set that
 * closes that gap, and it is deliberately only the *difference*: the prefix
 * clause still carries its own descendants, so a caller unions the two rather
 * than replacing one with the other. Namespace containment stays meaningful in
 * its own right, and narrowing it would trade a silent omission for a different
 * silent omission.
 *
 * Cost is one pass over the tenant's types per call, which is small (the
 * platform ships ~42) and only paid when a subtree is actually being resolved.
 */
export function declaredDescendantsOutsideNamespace(
  rootId: string,
  tenantId?: string | null,
): string[] {
  const prefix = `${rootId}.`;
  const out: string[] = [];
  for (const schema of listTypes(tenantId)) {
    if (schema.id === rootId) continue;
    if (schema.id.startsWith(prefix)) continue;
    // Only types that declare a parent can reach the root by any route other
    // than their name, so the walk is skipped for the overwhelming majority.
    if (!schema.parent) continue;
    if (isSubtypeOf(schema.id, rootId, tenantId)) out.push(schema.id);
  }
  return out;
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

// Defense-in-depth caps applied per-field, independent of the server's
// global request-body size limit. They bound a single field even when the
// overall body is under the request cap (e.g. one enormous string in an
// otherwise small payload). Generous on purpose — they trip on abuse, not
// on legitimate long-form content; the per-field `maxLength` / `maxItems`
// overrides raise (or lower) them where a type genuinely needs it.
const DEFAULT_MAX_STRING_LENGTH = 100_000;
const DEFAULT_MAX_ARRAY_ITEMS = 10_000;

// Build a length-bounded, NUL-rejecting string schema. The `.max()` cap
// applies before the NUL refine so an over-long string fails fast with a
// clear bound error.
const boundedString = (field: FieldDefinition): z.ZodType =>
  noNullByte(z.string().max(field.maxLength ?? DEFAULT_MAX_STRING_LENGTH));

function fieldToZod(field: FieldDefinition): z.ZodType {
  let schema: z.ZodType;

  switch (field.type) {
    case "string":
      schema = boundedString(field);
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
      schema = boundedString(field);
      break;
    case "date":
      schema = boundedString(field);
      break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        schema = z.enum(field.enum_values as [string, ...string[]]);
      } else {
        schema = boundedString(field);
      }
      break;
    case "array":
      schema = z
        .array(z.unknown())
        .max(field.maxItems ?? DEFAULT_MAX_ARRAY_ITEMS);
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
// Type schema validation
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a type schema submitted at runtime.
 *
 * The rules live in `@withmarfa/types`, which the in-tree codegen also calls,
 * so a schema is judged by one implementation whichever path it arrived on.
 * This wrapper only supplies the two things the validator can't reach on its
 * own: tenant-scoped registry resolution for the inheritance and
 * `compatible_with` checks, and the namespace grammar.
 *
 * Errors carry `field`, `expected`, `actual` and `hint`; the subset that maps
 * to a dedicated HTTP error code also carries `code` — `property_shadows_field`,
 * `inheritance_violation`, `compatible_with_violation`.
 */
export function validateTypeSchema(
  input: unknown,
  tenantId?: string | null,
): TypeSchemaValidationResult {
  return validateTypeSchemaShape(input, {
    resolveSchema: (typeId) => resolveSchema(typeId, tenantId),
    isValidTypeIdentifier,
  });
}
