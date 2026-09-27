// Type schema shape — data lives in core/*.json; generated output in generated/.

/**
 * Lifecycle states for items. Defined at the metadata layer, universal across
 * all types. Most types use the three-state graph (`active` ↔ `archived`,
 * either → `trashed`, `trashed` → `active`); `system.*` types are restricted
 * to `active` → `revoked` (terminal). Per-type validation enforces which
 * states a given type may occupy.
 */
export type ItemState = "active" | "archived" | "trashed" | "revoked";

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "url"
  | "email"
  | "datetime"
  | "date"
  | "enum"
  | "array"
  | "object"
  | "thumbnail";

/**
 * Semantic refinements on top of a `FieldType`. Those with a first-class
 * `FieldType` of the same name normalize into `type`, so `{ type: "string",
 * format: "url" }` and `{ type: "url" }` are the same declaration. The rest
 * (`bcp47`, `iso3166`) annotate a `string` field whose contents follow a
 * published standard but which has no dedicated `FieldType`; they survive
 * normalization as `format`.
 */
export type FieldFormat =
  "url" | "email" | "datetime" | "date" | "thumbnail" | "bcp47" | "iso3166";

export interface FieldDefinition {
  type: FieldType;
  description?: string;
  required?: boolean;
  enum_values?: string[];
  items_type?: string;
  /**
   * Semantic refinement of a `string` field. Only the annotation-only formats
   * (`bcp47`, `iso3166`) survive here — the formats that have a matching
   * `FieldType` normalize into `type` instead, so there is exactly one way to
   * read a field's shape. Carried through the registry and the type diff so a
   * schema round-trips unchanged; value-level enforcement of the annotation
   * formats is not applied at write time.
   */
  format?: FieldFormat;
  /**
   * Opt-out flag for full-text search indexing. When `false`, the field's
   * content is excluded from FTS, which is the FTS5 `extra` column.
   * Defaults to `true` — a
   * field without this flag is indexed. Only meaningful for `string`-typed
   * fields; ignored elsewhere. Use this for fields that carry secrets,
   * opaque ids, or noisy content that shouldn't surface in search results.
   */
  searchable?: boolean;
  /**
   * Per-field override for the default maximum string length enforced at
   * validation. Only meaningful for `string`-typed fields (incl. `enum`
   * fallbacks); ignored elsewhere. Defense-in-depth alongside the global
   * request-body cap. When omitted, a generous default (100_000 chars)
   * applies; set this higher for a field that legitimately carries very
   * long text, or lower to tighten a field.
   */
  maxLength?: number;
  /**
   * Per-field override for the default maximum element count on
   * `array`-typed fields. Ignored on non-array fields. When omitted, a
   * generous default (10_000 elements) applies. Defense-in-depth
   * alongside the global request-body cap.
   */
  maxItems?: number;
}

export interface VersionPolicy {
  recent_days?: number;
  daily_snapshot_days?: number;
  weekly_snapshot_days?: number;
  max_versions?: number;
}

/**
 * Declarative hints for generic renderers that consume items of this type
 * without type-specific code. Readers consult these first, then fall back in
 * a fixed order: title → name → first non-empty string field → type id.
 */
export interface DisplayHints {
  /** Field that carries this type's canonical display title. */
  title_field?: string;
  /** Field that carries this type's canonical body text. */
  body_field?: string;
}

/**
 * Per-field strategy for resolving concurrent edits on the same item.
 *
 * - `last_writer_wins` — server's current value wins on conflict; the
 *   client's stale change is dropped. The default for every field;
 *   matches single-value semantics like enums, scalars, IDs, and
 *   timestamps.
 * - `keep_both_copies` — preserve the client's edit by spawning a sibling
 *   item of the same type tagged `conflicted-copy`. The original item
 *   accepts the server's current value for the field. Reserved for the
 *   conventional user-authored long-text fields (`body`, `notes`,
 *   highlight `note`), where silently dropping a write is the worst
 *   outcome.
 */
export type MergeStrategy = "last_writer_wins" | "keep_both_copies";

/**
 * Per-type conflict-resolution policy. Mirrors the `display_hints`
 * uniform-object precedent: a `fields` map of field-name → strategy and
 * an optional `default` for unlisted fields. Both keys are optional;
 * unspecified strategies fall back to `last_writer_wins`.
 *
 * Inherited by descendant types: child `fields` entries merge over parent
 * `fields` entries (child wins per key); child `default` replaces parent
 * `default`. Empty `fields` on a child does not erase parent entries.
 */
export interface MergePolicy {
  /** Per-field strategy. Field names must exist in the type's `fields` map. */
  fields?: Record<string, MergeStrategy>;
  /** Fallback strategy for fields not listed in `fields`. Defaults to `last_writer_wins`. */
  default?: MergeStrategy;
}

/**
 * A structural role a type declares about itself, describing what items of
 * that type are for rather than what they hold. Roles exist so a relationship
 * can constrain on a property a type declares instead of on a list of type
 * names, which only ever admits the containers the platform thought of first.
 *
 * - `container` — items of this type hold other items. `in-collection` admits
 *   any container as its target.
 */
export type TypeRole = "container";

/** Every role a type may declare. Closed set; the validator refuses others. */
export const TYPE_ROLES = ["container"] as const satisfies readonly TypeRole[];

export interface TypeSchema {
  id: string;
  parent?: string;
  label?: string;
  description?: string;
  version: number;
  fields: Record<string, FieldDefinition>;
  /**
   * Structural roles this type plays. Inherited: a subtype plays every role
   * its ancestors declare, so a role is stated once at the top of a family.
   * Additive — a type that declares none behaves exactly as before.
   */
  roles?: TypeRole[];
  display_hints?: DisplayHints;
  version_policy?: VersionPolicy;
  merge_policy?: MergePolicy;
  /**
   * Sibling-type compatibility declarations. For each named target this type
   * asserts a structural-superset relationship — every required field on the
   * target is present here with a matching shape — so a reader that
   * understands the target can read this type without knowing it. Server
   * verifies every entry at registration; a mismatched claim is rejected with
   * `compatible_with_violation`.
   */
  compatible_with?: string[];
}

/**
 * Cardinality of an edge type. Enforced at edge-creation time.
 * - one-to-one: each source and each target may appear at most once.
 * - one-to-many: each target may appear at most once (e.g. parent-of: one parent per child).
 * - many-to-one: each source may appear at most once (e.g. in-thread: each member in one thread).
 * - many-to-many: no uniqueness constraint beyond exact (source, target, type) duplicates.
 */
export type EdgeCardinality =
  "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

/**
 * What happens to the edge and related items when one of the endpoint items
 * is deleted.
 * - cascade: when the source item is deleted, also delete the target item
 *   (canonical use: parent-of — deleting the parent deletes the children).
 * - orphan: when either endpoint is deleted, just remove the edge row; the
 *   other endpoint stays.
 * - block: reject the item delete if any edge of this type exists.
 */
export type EdgeCascade = "cascade" | "orphan" | "block";

export interface EdgeTypeSchema {
  id: string;
  label?: string;
  description?: string;
  cardinality: EdgeCardinality;
  /**
   * What is valid on the source side. Three entry forms, and an endpoint
   * satisfies the constraint when any one of them matches:
   *
   * - `*` — every type.
   * - a type identifier — that type, inheritance-aware, so subtypes satisfy
   *   an ancestor constraint.
   * - `role:<name>` — every type declaring that `TypeRole`, its own or
   *   inherited. Constraining on a role rather than on names is what lets a
   *   relationship admit a type nobody had written when the edge shipped,
   *   including one published by somebody who cannot edit this file.
   */
  source_type_constraints: string[];
  /** As above, for the target side. */
  target_type_constraints: string[];
  /** Cascade behavior when endpoints are deleted. */
  cascade_on_delete: EdgeCascade;
  /**
   * JSON-schema-shaped map of allowed edge `properties`. Empty object means
   * no validated properties (but arbitrary properties are still rejected).
   */
  property_schema: Record<string, FieldDefinition>;
  /**
   * The name the edge goes by read from its target, such as `child-of` for
   * `parent-of`. A folder writes an edge of a type that declares one in the
   * target's file rather than the source's, so the parent's file does not
   * carry every child and an attachment that cannot carry frontmatter is
   * still written somewhere. Nothing about how the edge is stored changes.
   */
  reverse_name?: string;
}
