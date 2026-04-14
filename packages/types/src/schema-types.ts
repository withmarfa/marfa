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
}
