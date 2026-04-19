// Schema shape — describes how a Myme type schema is structured.
// Data (the core type JSON files) lives alongside; generated output wires them together.

/**
 * Lifecycle states for items. Defined at the metadata layer, universal across
 * all types — types do not declare their own state machines.
 */
export type ItemState = "active" | "archived" | "trashed";

/** Supported field types in a type schema. */
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
  | "object";

/** Defines a single field within a type schema. */
export interface FieldDefinition {
  type: FieldType;
  description?: string;
  required?: boolean;
  enum_values?: string[];
  items_type?: string;
}

/** Per-type version retention policy (overrides global defaults). */
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
 *   client's stale change is dropped. The historical default for every
 *   field; matches single-value semantics like enums, scalars, IDs, and
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

/** A complete type schema — the data contract for a Myme type. */
export interface TypeSchema {
  id: string;
  parent?: string;
  label?: string;
  description?: string;
  version: number;
  fields: Record<string, FieldDefinition>;
  display_hints?: DisplayHints;
  version_policy?: VersionPolicy;
  merge_policy?: MergePolicy;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

/**
 * Cardinality of an edge type. Enforced at edge-creation time.
 * - one-to-one: each source and each target may appear at most once.
 * - one-to-many: each target may appear at most once (e.g. parent-of: one parent per child).
 * - many-to-one: each source may appear at most once (e.g. in-thread: each member in one thread).
 * - many-to-many: no uniqueness constraint beyond exact (source, target, type) duplicates.
 */
export type EdgeCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many";

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

/**
 * A complete edge type schema. Describes one named relationship kind —
 * constraints, cascade, property shape.
 */
export interface EdgeTypeSchema {
  id: string;
  label?: string;
  description?: string;
  cardinality: EdgeCardinality;
  /**
   * Type identifiers (or `*`) that are valid on the source side. Inheritance-
   * aware: subtypes satisfy an ancestor constraint.
   */
  source_type_constraints: string[];
  /** As above, for the target side. */
  target_type_constraints: string[];
  /** Cascade behaviour when endpoints are deleted. */
  cascade_on_delete: EdgeCascade;
  /**
   * JSON-schema-shaped map of allowed edge `properties`. Empty object means
   * no validated properties (but arbitrary properties are still rejected).
   */
  property_schema: Record<string, FieldDefinition>;
}
