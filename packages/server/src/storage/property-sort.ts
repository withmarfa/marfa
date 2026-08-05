/**
 * ORDER BY expression builder for `?sort=properties.<field>`.
 *
 * The item-list query can sort on an arbitrary property field by extracting the
 * value out of the `properties` JSON text column. Datetimes and strings order
 * lexically (ISO-8601 sorts correctly as text); numeric fields are cast so 2
 * sorts before 10. Enum-semantic ordering is out of scope — those fields carry
 * a meaning-bearing order that isn't lexical, so the client owns that sort.
 *
 * The JSON-extraction expressions mirror `filter-sql.ts`'s `propertyFieldSql`
 * exactly so a sort and a filter on the same field read the same value. The
 * field name is validated against `^[a-z0-9_]+$` upstream (`parseSortField` in
 * `interface.ts`) before it reaches here, and every value comparison is
 * parameterized, so the path is safe against injection.
 */

import { sql, type SQL } from "drizzle-orm";
import { getResolvedFields } from "@withmarfa/shared";
import type { SqlDialect } from "./filter-sql.js";
import type { parseSortField } from "./interface.js";

/**
 * Extract the cursor sort value for a property sort from an already-parsed item.
 *
 * The value must match what the SQL `json_extract` / `->>` expression returned
 * for the same row, so the next page's keyset comparison lines up. JSON text
 * extraction yields scalars as their string form (a number becomes `"42"`), so
 * numbers and booleans are stringified to mirror that; an absent or null field
 * yields `null`, which the cursor encodes to mark the trailing NULLS-LAST
 * block. Non-scalar values (object / array) can't participate in a keyset
 * comparison — they sort as NULL, matching `->>` returning NULL for a non-text
 * JSON node.
 */
export function propertySortValue(
  properties: Record<string, unknown>,
  sort: ReturnType<typeof parseSortField>,
): string | null {
  if (sort.kind !== "property") return null;
  const value = properties[sort.field];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // null / undefined / object / array — no scalar to compare; sorts as the
  // NULLS-LAST tail, mirroring `->>` returning NULL for a non-text JSON node.
  return null;
}

/**
 * Decide whether a property field should order numerically. Numeric ordering
 * applies only when a single `type` filter narrows the list AND that type
 * declares the field as `integer` / `number`. Without a confident numeric
 * signal — no type filter, a multi-type list, or an ambiguous field — the sort
 * falls back to text ordering, which is correct for datetimes and strings and
 * safe (never throws) for everything else.
 */
function isNumericSortField(
  field: string,
  typeFilter: string | undefined,
  spaceId: string | undefined,
): boolean {
  if (!typeFilter) return false;
  // A `core.entity.*` style subtree filter doesn't resolve to one concrete
  // type, so we can't trust a single field-type reading. Text-order it.
  const concreteType = typeFilter.endsWith(".*")
    ? undefined
    : typeFilter.replace(/\.\*$/, "");
  if (!concreteType) return false;
  const fields = getResolvedFields(concreteType, spaceId);
  const def = fields?.[field];
  return def?.type === "integer" || def?.type === "number";
}

/** The SQL expression that extracts a property value as text, per dialect. */
function textExtract(
  propertiesCol: unknown,
  field: string,
  dialect: SqlDialect,
): SQL {
  return dialect === "sqlite"
    ? sql`json_extract(${propertiesCol}, ${"$." + field})`
    : sql`${propertiesCol}->>${field}`;
}

/** The SQL expression that extracts a property value as a number, per dialect.
 *  SQLite's `CAST(... AS REAL)` yields 0 for non-numeric text, so callers must
 *  only reach this when the field is known numeric. */
function numericExtract(
  propertiesCol: unknown,
  field: string,
  dialect: SqlDialect,
): SQL {
  return dialect === "sqlite"
    ? sql`CAST(json_extract(${propertiesCol}, ${"$." + field}) AS REAL)`
    : sql`(${propertiesCol}->>${field})::numeric`;
}

export interface PropertySortExpr {
  /** The expression to ORDER BY / compare in the keyset cursor clause. */
  expr: SQL;
  /** True when ordering numerically (drives cursor value coercion). */
  numeric: boolean;
}

/**
 * Build the ORDER BY expression for a property-field sort. `numeric` reports
 * whether the expression casts to a number, so the cursor keyset comparison can
 * coerce its bound value to match.
 */
export function buildPropertySortExpr(
  propertiesCol: unknown,
  field: string,
  dialect: SqlDialect,
  typeFilter: string | undefined,
  spaceId: string | undefined,
): PropertySortExpr {
  const numeric = isNumericSortField(field, typeFilter, spaceId);
  const expr = numeric
    ? numericExtract(propertiesCol, field, dialect)
    : textExtract(propertiesCol, field, dialect);
  return { expr, numeric };
}
