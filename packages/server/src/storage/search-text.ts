import {
  ALWAYS_SEARCHED_FIELDS,
  getSearchableStringFields,
  isFieldSearchableExcluded,
} from "@withmarfa/shared";

/**
 * The core search fields, indexed as named columns in the FTS5 table. Any of
 * them can be opted out via `searchable: false` on the type's field
 * definition. The list type registration reads, so a field it refuses to make
 * a thumbnail is exactly a field indexed here.
 */
export const CORE_FTS_FIELDS = ALWAYS_SEARCHED_FIELDS;

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
 * The declared string fields beyond the core four, in field-name order: the
 * order the device joins them in, so a phrase that crosses two fields matches
 * on both or on neither.
 */
function searchableExtraFields(typeId: string): string[] {
  return getSearchableStringFields(typeId).sort(compareBytes);
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * What a type contributes to the index apart from any one row: the core
 * fields it opts out of and the extra fields it declares. Two states of a
 * type with one shape index every row alike, so a change that leaves the
 * shape alone leaves the stored rows as they are.
 */
export function searchableShape(typeId: string): string {
  return JSON.stringify([
    CORE_FTS_FIELDS.filter((field) => isFieldSearchableExcluded(typeId, field)),
    searchableExtraFields(typeId),
  ]);
}

/**
 * The FTS text extractor, and the single source of truth for what text
 * contributes to the index for an item. `SqliteSearchStore` consults it on
 * write, so the indexed surface is whatever this returns.
 *
 * - Core fields (title, body, description, name) are always candidates, but
 *   a type may opt any of them out via `searchable: false` on its field
 *   definition. Fields without the flag are searchable.
 * - The `extra` slot collects every string field that isn't a core field and
 *   isn't `searchable: false`, in field-name byte order.
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

  const extraFields = typeId ? searchableExtraFields(typeId) : [];
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
