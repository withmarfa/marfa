import { z } from "zod";
import {
  ALL_TYPES,
  ALL_CONNECTOR_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPE_IDS,
  RESERVED_ITEM_FIELDS,
  ROLE_CONSTRAINT_PREFIX,
  TYPE_ROLES,
  isRoleConstraint,
  roleFromConstraint,
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
  PlatformTypeId,
  SchemaValidationIssue,
  TypeRole,
  TypeSchema,
  TypeSchemaValidationResult,
  VersionPolicy,
} from "@withmarfa/types";
import { ErrorCode, MarfaError } from "./errors.js";
import type { EnforcementSettings, InstanceConfig } from "./types.js";
import { isValidTypeIdentifier, RESERVED_ROOTS } from "./validation.js";

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
  PlatformTypeId,
  SchemaValidationIssue,
  TypeRole,
  TypeSchema,
  TypeSchemaValidationResult,
  VersionPolicy,
};
// `ALL_TYPE_IDS` and `PlatformTypeId` are the compile-time half of the
// registry: a consumer that keys a map or a switch by type id declares it
// `satisfies Partial<Record<PlatformTypeId, …>>` and a deleted identifier
// becomes a type error in that repository's own typecheck.
export { ALL_TYPES, ALL_CONNECTOR_TYPES, ALL_SYSTEM_TYPES, ALL_TYPE_IDS };
// The closed role vocabulary and the constraint-entry grammar, re-exported so
// a consumer validating or rendering roles reads the same list and the same
// parser the validator enforces.
export {
  ROLE_CONSTRAINT_PREFIX,
  TYPE_ROLES,
  isRoleConstraint,
  roleFromConstraint,
};

// ---------------------------------------------------------------------------
// Universal fields (available on every type)
// ---------------------------------------------------------------------------

const UNIVERSAL_FIELDS: Record<string, FieldDefinition> = {
  attachments: { type: "array", items_type: "object" },
  links: { type: "array", items_type: "string" },
};

// The platform-shipped types are bundled with @withmarfa/types and resolve
// for every caller. This map is read-only after construction. Three
// families feed it and each stays identifiable afterwards: `ALL_TYPES` is the
// core set, `ALL_CONNECTOR_TYPES` is the vendor-shaped set a connector writes
// into, and `ALL_SYSTEM_TYPES` is the platform-internal set. They resolve
// identically — the split describes provenance so a catalog can say what a
// reader is actually looking at, not a difference in how lookups behave.
const _coreRegistry = new Map<string, TypeSchema>(
  [...ALL_TYPES, ...ALL_CONNECTOR_TYPES, ...ALL_SYSTEM_TYPES].map((schema) => [
    schema.id,
    schema,
  ]),
);

/**
 * Which shipped family a platform type belongs to. The split is provenance
 * rather than behaviour, but two consumers key on it — the lifecycle and
 * search restrictions that apply to `system.*`, and the catalog's account of
 * which types exist because a specific upstream service does — so it cannot
 * be derived from the identifier and has to travel with the schema.
 */
/** Valid families as a readonly tuple. The union below is derived from it. */
export const PLATFORM_TYPE_FAMILIES = ["core", "connector", "system"] as const;

export type PlatformTypeFamily = (typeof PLATFORM_TYPE_FAMILIES)[number];

/**
 * Whether a value is one of the families this build recognizes.
 *
 * Exists because the column is plain text with no constraint: a family read
 * back from storage is a bare string, and the code that consumes one
 * compares it against a literal. Testing only that the value is *present*
 * leaves an empty string, a truncated write, or a family a later build
 * introduced looking exactly like a placeable row — which on this field
 * means a shipped type landing in the wrong permission category rather than
 * being refused.
 *
 * The union is derived FROM the array rather than the array being annotated
 * with the union, and that direction is the whole point. Annotated
 * `readonly PlatformTypeFamily[]`, a subset is assignable, so a family
 * added to the union would compile with the array untouched and this
 * predicate would silently stop recognizing it. An annotated array is only
 * safe when some mapped `Record` over the same union sits beside it and
 * fails to compile until the author updates it. There is no such record
 * over this union, so the annotation would take everything from that shape
 * except the part that made it work.
 */
export function isPlatformTypeFamily(
  value: unknown,
): value is PlatformTypeFamily {
  return (
    typeof value === "string" &&
    (PLATFORM_TYPE_FAMILIES as readonly string[]).includes(value)
  );
}

/** One seeded platform type: its schema and the family it belongs to. */
export interface SeededPlatformType {
  schema: TypeSchema;
  family: PlatformTypeFamily;
}

/**
 * Where a registered type came from. Immutability used to be a compiled set —
 * a type was unmodifiable because the build said so. As a row property it can
 * distinguish the cases that actually differ: the platform vocabulary is
 * locked, a type a connector published is updatable by that connector's
 * own package and nothing else, and a type a person registered is theirs.
 *
 * **`unknown` is a real answer, not a missing one.** An archive taken before
 * archives carried provenance has none to replay, and the restore has to
 * write something. The three substantive values are all wrong for it: `user`
 * is what the consent screen offers a read-and-write wildcard over, and
 * claiming it for a row that may be a connected service's mirror is the
 * laundering this value exists to stop; `connector` claims a publisher
 * nobody recorded; `platform` is a property of the build and can never be
 * written from a request. Saying "nobody knows" lets the consent screen
 * offer the row read-only rather than guess, which is the one option that
 * is neither a silent upgrade nor a silent disappearance.
 *
 * **An older build meeting this value does not understand it**, which is the
 * cost of adding a member at all and is worth stating rather than
 * discovering. On a rollback, `isValidTypeOrigin` returns false for it, so
 * every read of such a row logs at error level, and it matches neither the
 * `user` nor the `connector` test, so its root falls out of every default
 * bundle instead of being offered read-only. That is the same shape a
 * rollback already produces for an unrecognized `family`, and the same
 * answer applies: the value passes through unchanged and the doors stay
 * shut rather than one being picked.
 *
 * **There is no non-destructive way back.** Updating a type carries no
 * provenance, so a row recorded this way keeps the value until it is
 * deleted and registered again.
 */
/** Valid origins as a readonly tuple. The union below is derived from it. */
export const TYPE_ORIGINS = [
  "platform",
  "connector",
  "user",
  "unknown",
] as const;

export type TypeOrigin = (typeof TYPE_ORIGINS)[number];

/**
 * Whether a value is one of the origins this build recognizes.
 *
 * Reporting only. Unlike `isPlatformTypeFamily`, whose caller falls back to
 * the restrictive family, nothing substitutes a value on a false here: an
 * origin outside the union already fails every equality its consumers test,
 * which excludes the row from the shipped vocabulary and from a person's own
 * registrations alike. Substituting a member of the union would pick one of
 * those doors and open it.
 *
 * Derived from the array for the reason `isPlatformTypeFamily` gives.
 */
export function isValidTypeOrigin(value: unknown): value is TypeOrigin {
  return (
    typeof value === "string" &&
    (TYPE_ORIGINS as readonly string[]).includes(value)
  );
}

/**
 * Refill the platform registry from seeded rows.
 *
 * The compiled arrays remain the map's contents until this is called, which is
 * what keeps every consumer that never boots a server — the SDK, a browser
 * bundle, the codegen — resolving the shipped vocabulary with no database in
 * sight. A server calls this once at boot so an instance's vocabulary is the
 * data it holds rather than the build it happens to be running.
 *
 * The Map and both Sets are mutated in place rather than replaced, because
 * `TYPE_REGISTRY`, `SYSTEM_TYPE_IDS` and `CONNECTOR_TYPE_IDS` are exported
 * bindings that consumers capture at import time. Handing back new objects
 * would leave every existing reference pointing at the pre-seed contents.
 */
export function seedPlatformTypes(seeded: readonly SeededPlatformType[]): void {
  _coreRegistry.clear();
  _systemTypeIds.clear();
  _connectorTypeIds.clear();
  for (const { schema, family } of seeded) {
    _coreRegistry.set(schema.id, schema);
    // Exhaustive rather than a pair of `if`s, so a family added to the
    // union fails to compile here instead of landing in neither set. The
    // sets decide lifecycle and whether a caller may set `tier`, so a
    // family that reaches neither is not inert — it silently gives a new
    // shipped type the three-state lifecycle and an open `tier`.
    switch (family) {
      case "system":
        _systemTypeIds.add(schema.id);
        break;
      case "connector":
        _connectorTypeIds.add(schema.id);
        break;
      case "core":
        break;
      default: {
        const _exhaustive: never = family;
        void _exhaustive;
      }
    }
  }
  // Every cached Zod schema was compiled against the pre-seed field set.
  zodSchemaCache.clear();
  zodSchemaStrictCache.clear();
}

/**
 * The shipped set as the build carries it, for seeding an instance that has
 * no rows yet. The repo's JSON files stay canonical: they are what a fresh
 * instance is seeded from, and what the codegen and the Swift wrapper
 * generation read when no server exists to ask.
 */
export function shippedPlatformTypes(): SeededPlatformType[] {
  return [
    ...ALL_TYPES.map((schema) => ({ schema, family: "core" as const })),
    ...ALL_CONNECTOR_TYPES.map((schema) => ({
      schema,
      family: "connector" as const,
    })),
    ...ALL_SYSTEM_TYPES.map((schema) => ({
      schema,
      family: "system" as const,
    })),
  ];
}

/**
 * Custom types registered on this instance, keyed by id. One bucket: a
 * registration is visible to every caller, and the lifecycle rules key on
 * the identifier rather than on which map holds the schema.
 */
const _customRegistry = new Map<string, TypeSchema>();

/**
 * Resolves a type schema: the shipped registry first, then the instance's
 * own registrations. This is the single resolution primitive every helper
 * below threads through, including the inheritance-chain walks (a custom
 * type's parent may itself be a custom type).
 */
function resolveSchema(typeId: string): TypeSchema | undefined {
  return _coreRegistry.get(typeId) ?? _customRegistry.get(typeId);
}

// Mutable behind the readonly exports below, so `seedPlatformTypes` can refill
// them in place without invalidating references consumers captured at import.
const _systemTypeIds = new Set<string>(ALL_SYSTEM_TYPES.map((s) => s.id));
const _connectorTypeIds = new Set<string>(ALL_CONNECTOR_TYPES.map((s) => s.id));

/** The set of type IDs in the platform `system.*` registry. These are tracked separately so consumers can apply the lifecycle and search restrictions that apply to system types. */
export const SYSTEM_TYPE_IDS: ReadonlySet<string> = _systemTypeIds;

/**
 * The set of type IDs shipped as connector types: one vendor's payload shape,
 * present so a connector has somewhere faithful to write. They carry no
 * behavioral restrictions — the split from the core set is a provenance
 * distinction, so a catalog can tell a reader which types are the shared
 * vocabulary and which exist because a specific upstream service does.
 */
export const CONNECTOR_TYPE_IDS: ReadonlySet<string> = _connectorTypeIds;

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
 * Computes the effective enforcement settings for a given (instance config,
 * credential) pair. Per-credential override wins where set, falling back to
 * the instance default. All three levers are independently overridable —
 * setting `strict_mode` on the credential does not clear the instance
 * `source_allowlist`.
 */
export function resolveEnforcement(
  instance: InstanceConfig | null | undefined,
  credential: { enforcement_override?: EnforcementSettings } | null | undefined,
): EnforcementSettings {
  const instanceSettings = instance?.enforcement ?? {};
  const override = credential?.enforcement_override ?? {};
  return {
    strict_mode: override.strict_mode ?? instanceSettings.strict_mode,
    source_allowlist:
      override.source_allowlist ?? instanceSettings.source_allowlist,
    source_filter: override.source_filter ?? instanceSettings.source_filter,
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
 * The core type registry — the shipped core + system type schemas by
 * identifier. Custom types are NOT exposed here; consumers that need the
 * full set call `listTypes()`, and lookups go through `getTypeSchema(id)`. The OAuth scope allow-list and consent
 * descriptions read this for the static core-scope enumeration.
 */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = _coreRegistry;

/** Resolves a type schema: the shipped set, then the instance's own
 *  registrations. */
export function getTypeSchema(typeId: string): TypeSchema | undefined {
  return resolveSchema(typeId);
}

/** Lists every type: the shipped core + system set plus the instance's
 *  own custom types. */
export function listTypes(): TypeSchema[] {
  return [..._coreRegistry.values(), ..._customRegistry.values()];
}

/**
 * The five-tier namespace classification. The first segment of a type
 * identifier determines its tier; the reserved roots that name a tier
 * (`core`, `system`, `app`, `user`, `marfa`) carry platform-defined
 * semantics, anything else is a publisher handle.
 *
 * **`RESERVED_ROOTS` is wider than this, and by how much is not stated
 * here.** It is `NAMESPACE_TIER_ROOTS` plus every scope-family root plus the
 * retired one, and `scope-roots.ts` composes it from exactly those lists — so
 * the arithmetic is the code that produces it rather than a sentence with a
 * number in it. A sentence is what rotted the last time the set grew, and it
 * rotted silently, because nothing compiles a docblock.
 *
 * What the extra roots have in common is that no type is ever registrable
 * under one, so no identifier reaching a classifier can carry them, and none
 * has a tier because there is nothing there to classify.
 *
 * That fall-through is load-bearing rather than incidental: a tierless
 * reserved root classifies as `publisher`, which is how a caller tells
 * `user.note` (reserved, and a legitimate custom type) from `content.note`
 * (reserved, and a namespace nothing may occupy) without keeping a second
 * list beside `RESERVED_ROOTS`.
 */
export type NamespaceTier =
  "core" | "system" | "app" | "user" | "publisher" | "marfa";

/**
 * Returns true if the candidate is a reserved root prefix.
 *
 * The set is `validation.ts`'s, imported rather than restated. A second copy
 * lived here and the two were free to drift, which on this particular set is
 * a security question and not a tidiness one: `isReservedRoot` is what the
 * registration paths ask, `RESERVED_ROOTS` is what the identifier grammar
 * asks, and a root present in one and absent from the other is a namespace
 * that refuses registration in one direction and admits it in the other.
 */
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

/**
 * Which tiers the platform owns outright. Exhaustive over
 * {@link NamespaceTier} rather than a list of the three that answer `true`,
 * so a tier added to the union stops the package compiling here until
 * somebody has said which side it falls on. {@link seedPlatformTypes} makes
 * the same trade with a `switch` over the family union, for the same reason:
 * a value reaching neither branch is not inert.
 */
const PLATFORM_TIER_MEMBERSHIP: Readonly<Record<NamespaceTier, boolean>> = {
  core: true,
  system: true,
  marfa: true,
  app: false,
  user: false,
  publisher: false,
};

/**
 * The tiers the platform owns outright: exactly the three that `POST /types`
 * and an archive restore refuse for every credential, the operator key
 * included. An id under one of them can only have arrived by being seeded,
 * never by being registered, which is what lets a caller classify one by
 * name alone.
 *
 * Exported for the reason {@link isReservedRoot} gives about its own set, and
 * the reason binds harder here because there is no second grammar to fall
 * back on. Three sites decided this independently — the registration door,
 * the archive-restore door, and the hydration helper — and a tier present in
 * one copy and absent from another is a namespace one door refuses while
 * another treats it as somebody's custom type, which is a security question
 * rather than a tidiness one. Adding a member to {@link NamespaceTier} is the
 * move that would have done it silently in every copy at once.
 */
export const PLATFORM_TIERS: ReadonlySet<NamespaceTier> = new Set(
  (Object.keys(PLATFORM_TIER_MEMBERSHIP) as NamespaceTier[]).filter(
    (tier) => PLATFORM_TIER_MEMBERSHIP[tier],
  ),
);

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
 * Registers a custom type schema into the runtime overlay and clears the
 * compiled schemas it invalidates: this id always, and every descendant when
 * an existing registration is being replaced.
 *
 * **What callers filter out is what the platform map already holds, not what
 * the namespace looks like.** A type that map has is never registered here:
 * it resolves globally, and an overlay entry under its id is unreachable
 * rather than authoritative. A reserved-namespace type the build does NOT
 * hold is a different case and belongs here. An instance's shipped
 * vocabulary is seeded data, so a client can meet a `system.*` type its own
 * build never compiled in, and the overlay is the only place a client may
 * put one — the platform map is the build's own, so a runtime listing does
 * not belong in it. The lifecycle rules key on
 * the identifier rather than on which map holds the schema, so they answer
 * for such a type identically wherever it sits.
 */
export function registerTypeSchema(schema: TypeSchema): void {
  const bucket = _customRegistry;
  // Read before the write: on an update the descendants are the same either
  // way, but the flag is what keeps the walk off the boot path, where every
  // registration is a first one and the cache is empty anyway.
  const replacing = bucket.has(schema.id);
  bucket.set(schema.id, schema);
  evictCompiledSchema(schema.id);
  if (replacing) {
    for (const descendant of declaredDescendants(schema.id)) {
      evictCompiledSchema(descendant);
    }
  }
}

/**
 * Removes a custom type schema from the runtime overlay and clears the
 * compiled schemas its removal invalidates.
 */
export function unregisterTypeSchema(id: string): void {
  // Every descendant's compiled schema carries fields this type contributes,
  // so removing it invalidates all of them and not only its own.
  const invalidated = declaredDescendants(id);
  _customRegistry.delete(id);
  evictCompiledSchema(id);
  for (const descendant of invalidated) {
    evictCompiledSchema(descendant);
  }
}

/**
 * Drop a type's compiled Zod schemas.
 */
function evictCompiledSchema(id: string): void {
  zodSchemaCache.delete(zodCacheKey(id));
  zodSchemaStrictCache.delete(zodCacheKey(id));
}

/**
 * Every registered type whose declared parent chain reaches `rootId`,
 * excluding `rootId` itself.
 *
 * A compiled Zod schema is built from a type's RESOLVED fields, so changing
 * or removing a type invalidates every compiled schema below it as well as
 * its own. Nothing else evicts those, and a stale one goes on validating
 * writes against a shape the type no longer has.
 *
 * Downward, unlike every other walk here, and by declared parent alone. This
 * is not {@link declaredDescendantsOutsideNamespace}, which deliberately
 * omits descendants sitting under the root's own namespace because its caller
 * unions it with a name-prefix match. A short answer there is correct; a
 * short answer here leaves a cache entry nobody clears.
 */
function declaredDescendants(rootId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const schema of listTypes()) {
    if (!schema.parent) continue;
    const siblings = byParent.get(schema.parent);
    if (siblings) siblings.push(schema.id);
    else byParent.set(schema.parent, [schema.id]);
  }

  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of byParent.get(current) ?? []) {
      // A cycle that reached the registry cannot spin this: an id already
      // seen is never queued twice.
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * How deep a resolution walk follows an inheritance chain before refusing to
 * follow it further. It is really a depth bound: a cycle short enough to fit
 * inside it trips a walk's `seen` check first.
 *
 * Two bounds guard type inheritance and they are not the same thing.
 *
 * - **The registration cap** bounds what one checked registration may
 *   produce. `POST /types`, `PUT /types/:id` and the archive restore all run
 *   it before a schema enters the registry, and it sits well below this one
 *   deliberately. It lives with those routes, as
 *   `MAX_REGISTRATION_CHAIN_DEPTH` in the server's `routes/_parent-chain.ts`.
 * - **This backstop** bounds what a walk follows after the fact, whatever
 *   produced the chain. It guards the registry's own walks below
 *   (`getResolvedFields`, `isSubtypeOf`, `typeHasRole`) and the server's
 *   merge-policy and role chain in `storage/policy.ts`, which imports it
 *   rather than declaring a second copy beside it.
 *
 * One name stood for both until now, held privately here and exported under
 * the same spelling from the server's own file, at different values. Nothing
 * broke while this one stayed private, and exporting it as it stood is what
 * would have broken: a file needing both could not have imported both without
 * renaming one at the import. Names that say which is which are the point of
 * this pair, and the reason neither is called `MAX_INHERITANCE_DEPTH` now.
 *
 * Reaching this bound means a registration cap was bypassed or outgrown: a
 * schema entered by a path that runs no parent-chain check at all, or a chain
 * was grown past the registration cap in steps that each passed it.
 * Re-parenting does the second, because the check walks upward from the type
 * being changed and revalidates none of its descendants. `validateTypeSchema`
 * is not one of the guards this sits behind either: it tolerates an
 * unresolvable or cyclic parent rather than erroring.
 *
 * Throw a clear error rather than loop forever. These walks run per-write and
 * per-edge-check, so an unbounded loop here would hang the request, and the
 * bound is generous enough that a real hierarchy never reaches it.
 */
export const MAX_RESOLUTION_DEPTH = 100;

/**
 * Returns the fully resolved fields for a type, including inherited parent
 * fields and universal fields (attachments, links).
 *
 * Subtype fields override parent fields of the same name.
 */
export function getResolvedFields(
  typeId: string,
): Record<string, FieldDefinition> | undefined {
  const schema = resolveSchema(typeId);
  if (!schema) return undefined;

  const fields: Record<string, FieldDefinition> = { ...UNIVERSAL_FIELDS };

  // Collect the inheritance chain (parent first, then child). A custom type's
  // parent may itself be a custom type, so resolve each ancestor through the
  // same registry. The `seen` set guards against a cycle that somehow
  // reached the registry — without it a cyclic `parent` chain loops forever.
  const chain: TypeSchema[] = [];
  const seen = new Set<string>();
  let current: TypeSchema | undefined = schema;
  while (current) {
    if (seen.has(current.id) || seen.size >= MAX_RESOLUTION_DEPTH) {
      throw new MarfaError(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
        `Inheritance cycle or excessive depth detected resolving fields for type "${typeId}" (at "${current.id}")`,
        { type_id: typeId, at: current.id },
      );
    }
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? resolveSchema(current.parent) : undefined;
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
export function getSearchableStringFields(typeId: string): string[] {
  const fields = getResolvedFields(typeId);
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
): boolean {
  const fields = getResolvedFields(typeId);
  if (!fields) return false;
  const def = fields[fieldName];
  if (def?.type !== "string") return false;
  return def.searchable === false;
}

/**
 * Returns true if typeId is a subtype of (or equal to) parentId. Resolves the
 * inheritance chain through the instance's own registrations so custom types
 * (whose ancestors may also be custom) classify correctly.
 */
export function isSubtypeOf(typeId: string, parentId: string): boolean {
  if (typeId === parentId) return true;
  // The `seen` set guards against a cycle that somehow reached the registry —
  // without it a cyclic `parent` chain loops forever on this per-edge-check
  // hot path. See MAX_RESOLUTION_DEPTH.
  const seen = new Set<string>();
  let current = resolveSchema(typeId);
  while (current?.parent) {
    if (seen.has(current.id) || seen.size >= MAX_RESOLUTION_DEPTH) {
      throw new MarfaError(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
        `Inheritance cycle or excessive depth detected classifying type "${typeId}" (at "${current.id}")`,
        { type_id: typeId, at: current.id },
      );
    }
    seen.add(current.id);
    if (current.parent === parentId) return true;
    current = resolveSchema(current.parent);
  }
  return false;
}

/**
 * Whether a type declares a structural role, its own or inherited.
 *
 * Inheritance is walked here rather than baked into the stored schema, and
 * that is the whole point: a type registered at runtime under a shipped
 * parent never passes through the build-time codegen, so a role flattened at
 * build time would be a role only in-tree types could have. Resolving through
 * the chain means a runtime subtype of a container is a container, exactly as
 * a subtype already satisfies an ancestor's name constraint.
 *
 * Unknown types answer false — the same fail-closed rule the name-based
 * constraint check applies.
 */
export function typeHasRole(typeId: string, role: TypeRole): boolean {
  // Same cycle and depth guard as `isSubtypeOf`: this runs on the per-edge
  // check hot path, so a cyclic `parent` chain must not loop forever.
  const seen = new Set<string>();
  let current = resolveSchema(typeId);
  while (current) {
    if (current.roles?.includes(role)) return true;
    if (!current.parent) return false;
    if (seen.has(current.id) || seen.size >= MAX_RESOLUTION_DEPTH) {
      throw new MarfaError(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
        `Inheritance cycle or excessive depth detected resolving roles for type "${typeId}" (at "${current.id}")`,
        { type_id: typeId, at: current.id },
      );
    }
    seen.add(current.id);
    current = resolveSchema(current.parent);
  }
  return false;
}

/**
 * Every type in the vocabulary whose declared `parent` chain reaches
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
 * Cost is one pass over the registered types per call, which is small (the
 * platform ships ~42) and only paid when a subtree is actually being resolved.
 */
export function declaredDescendantsOutsideNamespace(rootId: string): string[] {
  const prefix = `${rootId}.`;
  const out: string[] = [];
  for (const schema of listTypes()) {
    if (schema.id === rootId) continue;
    if (schema.id.startsWith(prefix)) continue;
    // Only types that declare a parent can reach the root by any route other
    // than their name, so the walk is skipped for the overwhelming majority.
    if (!schema.parent) continue;
    if (isSubtypeOf(schema.id, rootId)) out.push(schema.id);
  }
  return out;
}

/**
 * The registered types that name `typeId` as their immediate parent.
 *
 * Direct children only, because the question it answers is whether deleting
 * this type would leave a chain pointing at nothing, and a grandchild's chain
 * stays intact as long as its own parent does.
 *
 * A pass over the registered types, which is a few dozen entries: the
 * platform ships about forty-five and a runtime registry adds a handful. An index on the declared
 * parent would carry more cost in keeping it true than the scan does.
 */
export function directChildrenOf(typeId: string): string[] {
  return listTypes()
    .filter((schema) => schema.parent === typeId)
    .map((schema) => schema.id);
}

/**
 * How many levels of subtype sit below `typeId`, counted in edges: a type
 * nothing inherits from answers 0, one with a child answers 1.
 *
 * The number a re-parent has to account for. Registration bounds the chain
 * ABOVE the type being written, which is the right thing for it to bound and
 * is not a bound on the chain's final depth: moving a type with subtypes
 * under a new parent lengthens every one of their chains without any of them
 * being submitted. Ten legal updates can therefore take a chain past a cap
 * that refused every step of building it directly.
 *
 * Walks the declared parent of every registered type, so a subtype named
 * outside its parent's namespace counts exactly like one named under it.
 */
export function maxDescendantDepth(typeId: string): number {
  const byParent = new Map<string, string[]>();
  for (const schema of listTypes()) {
    if (!schema.parent) continue;
    const siblings = byParent.get(schema.parent);
    if (siblings) siblings.push(schema.id);
    else byParent.set(schema.parent, [schema.id]);
  }

  // Iterative rather than recursive, and carrying the path rather than a
  // visited set: a node reachable by two routes is legitimately measured
  // twice, while a node already on this path is a cycle and stops the
  // descent. A cycle cannot reach the registry through any checked door,
  // but a walk that spins takes the request thread with it.
  let deepest = 0;
  const stack: { id: string; depth: number; path: ReadonlySet<string> }[] = [
    { id: typeId, depth: 0, path: new Set([typeId]) },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > deepest) deepest = current.depth;
    for (const child of byParent.get(current.id) ?? []) {
      if (current.path.has(child)) continue;
      stack.push({
        id: child,
        depth: current.depth + 1,
        path: new Set([...current.path, child]),
      });
    }
  }
  return deepest;
}

// ---------------------------------------------------------------------------
// Validation — Zod schema generation from field definitions
// ---------------------------------------------------------------------------

// The NUL codepoint (U+0000) is refused at the validation layer: it is the
// C string terminator, so a driver, a shell or a file format downstream
// truncates at it silently, and a database that refuses it surfaces as an
// unhandled 500 on otherwise well-formed client input. Rejecting it here
// covers every string field at once and the caller gets a clean 400. Every
// other control character (tab, newline, carriage return) and all higher
// Unicode (emoji, RTL marks, accents) round-trip unchanged, so the guard is
// scoped to U+0000 alone.
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
/**
 * Exported because a server-side writer that produces a string field has to
 * bound its output by what this will accept. Enrichment truncated at its own
 * independently-chosen ceiling and wrote a value the write path then refused,
 * on an item nobody could edit afterwards.
 */
export const DEFAULT_MAX_STRING_LENGTH = 100_000;
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
      // Either a full ISO 8601 instant with a mandatory offset (Z or
      // ±HH:MM), or a bare calendar date. The offset requirement is what
      // makes a timed value an instant rather than a wall-clock
      // ambiguity; the bare date is the all-day shape the event model
      // ruled explicitly — a whole day has no instant at all, and
      // `all_day` on the event is what says which reading applies. A
      // naive local time satisfies neither and is refused, so it cannot
      // surface later as a parse error in whatever reads it. Measured
      // against both live databases before enforcement: every stored
      // value in a declared datetime field already conforms, so no
      // migration accompanies this.
      schema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
      break;
    case "date":
      // A calendar date, YYYY-MM-DD. Same reasoning as datetime: the
      // declared format used to collapse to an unchecked bounded string.
      schema = z.iso.date();
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
// (rejects them). Keyed on the type id: one registry, one shape per id.
const zodSchemaCache = new Map<string, z.ZodType>();
const zodSchemaStrictCache = new Map<string, z.ZodType>();

function zodCacheKey(typeId: string): string {
  return typeId;
}

function getZodSchema(
  typeId: string,
  options?: { strict?: boolean },
): z.ZodType | undefined {
  const strict = options?.strict === true;
  const cache = strict ? zodSchemaStrictCache : zodSchemaCache;
  const key = zodCacheKey(typeId);
  const cached = cache.get(key);
  if (cached) return cached;

  const fields = getResolvedFields(typeId);
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
): Record<string, unknown> {
  const fields = getResolvedFields(typeId);
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

/**
 * Whether a type follows the bounded `active | revoked` lifecycle rather than
 * the canonical three-state one. The question both rules below ask, asked
 * once so the two cannot answer it differently.
 *
 * **`SYSTEM_TYPE_IDS` is the authority and stays it.** A server fills it at
 * boot from the stored `family` column, so it answers correctly for a type
 * the build has retired and for a row a newer build wrote — neither of which
 * a name test can do, and both of which a name test would get wrong in the
 * permissive direction.
 *
 * **The namespace is a belt, and on a client it is the half that catches
 * something.** There is no boot outside a server, so the set holds the
 * compiled shipped ids and nothing else. An instance's vocabulary is seeded
 * data, so a listing can carry a `system.*` type this build never compiled
 * in; its id is absent from the set, and without this test both rules would
 * hand it the three-state lifecycle the server does not give it — a client
 * accepting a transition the server refuses, and a delete aiming at a state
 * the type has no transition to.
 *
 * The belt is sound because `POST /types` refuses a reserved root for every
 * credential, platform included: a `system.*` id can only have been seeded,
 * so it is platform vocabulary whether or not this build carries it. That is
 * a different question from whether the type is already resolvable, which is
 * why the hydration helper still asks the platform map rather than the name.
 *
 * `contentCategoryPermissions` in `scopes.ts` pairs the same two tests for
 * the same reason, and the warning there applies here: dropping the set and
 * keeping the name test looks equivalent only because every system type
 * ships under `system.` today, and stops being so the moment one does not.
 */
export function hasBoundedLifecycle(typeId: string): boolean {
  return SYSTEM_TYPE_IDS.has(typeId) || isSystemType(typeId);
}

/**
 * The state a soft delete puts an item in, which is not the same state for
 * every type. `DELETE /items/:id` is a soft delete, and for most types that
 * means `trashed` — but `trashed` is not in the `system.*` lifecycle at all,
 * so a delete that assumed it put platform records into a state their own
 * type forbids, reachable by no transition and hidden from the default
 * listing that omits trashed rows. `revoked` is the terminal state the
 * bounded lifecycle actually has.
 *
 * Read this rather than hard-coding `trashed`: it is derived from the same
 * type classification the transition graph keys on, so the two cannot drift.
 */
export function softDeleteState(typeId: string): ItemState {
  return hasBoundedLifecycle(typeId) ? "revoked" : "trashed";
}

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
  const transitions = hasBoundedLifecycle(typeId)
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
 * own: registry resolution for the inheritance and
 * `compatible_with` checks, and the namespace grammar.
 *
 * Errors carry `field`, `expected`, `actual` and `hint`; the subset that maps
 * to a dedicated HTTP error code also carries `code` — `property_shadows_field`,
 * `inheritance_violation`, `compatible_with_violation`.
 */
export function validateTypeSchema(input: unknown): TypeSchemaValidationResult {
  return validateTypeSchemaShape(input, {
    resolveSchema: (typeId) => resolveSchema(typeId),
    isValidTypeIdentifier,
  });
}
