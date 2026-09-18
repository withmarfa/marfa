import {
  getSearchableStringFields,
  isFieldSearchableExcluded,
} from "@withmarfa/shared";

/**
 * The four core search fields. Both dialects index these as named columns
 * (SQLite FTS5) or named contributors to the materialized tsvector (PG).
 * Any of them can be opted out via `searchable: false` on the type's field
 * definition.
 */
export const CORE_FTS_FIELDS = [
  "title",
  "body",
  "description",
  "name",
] as const;

export type CoreFtsField = (typeof CORE_FTS_FIELDS)[number];

export interface SearchableText {
  /** Per-core-field text, blank when missing or `searchable: false`. */
  title: string;
  body: string;
  description: string;
  name: string;
  /**
   * Concatenation (space-joined) of every other string-typed field
   * declared on the type that isn't `searchable: false`. Empty when
   * the type isn't registered (codepath used by ad-hoc inserts that
   * pre-date type registration).
   */
  extra: string;
}

/**
 * Dialect-agnostic FTS text extractor. Both `SqliteSearchStore` and
 * `PgSearchStore` consult this so the indexed surface is identical across
 * dialects — same fields, same `searchable: false` opt-outs, same long-tail
 * ordering. The extractor is the single source of truth for "what text
 * contributes to FTS for this item."
 *
 * - Core fields (title, body, description, name) are always candidates, but
 *   a type may opt any of them out via `searchable: false` on its field
 *   definition. The opt-out flag defaults to `true` — existing types with no
 *   flag are unchanged.
 * - The `extra` slot collects every string field that isn't a core field and
 *   isn't `searchable: false`. Field ordering follows the
 *   `getSearchableStringFields` registry traversal so PG and SQLite indices
 *   stay byte-identical for the same input.
 * - Non-string property values are silently ignored (the store layer handles
 *   validation; FTS is opportunistic).
 */
export function extractSearchableText(
  properties: Record<string, unknown>,
  typeId: string | undefined,
): SearchableText {
  const result: Record<CoreFtsField, string> = {
    title: "",
    body: "",
    description: "",
    name: "",
  };
  for (const field of CORE_FTS_FIELDS) {
    // Resolve the type so a custom type's `searchable: false` opt-outs apply.
    if (typeId && isFieldSearchableExcluded(typeId, field)) continue;
    const value = properties[field];
    if (typeof value === "string") result[field] = value;
  }

  const extraFields = typeId ? getSearchableStringFields(typeId) : [];
  const extraParts: string[] = [];
  for (const field of extraFields) {
    const value = properties[field];
    if (typeof value === "string" && value) extraParts.push(value);
  }

  return {
    ...result,
    extra: extraParts.join(" "),
  };
}
