import { sql, type SQL } from "drizzle-orm";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { parseSortField } from "./interface.js";

/** JSON preserves scalar kinds inside the cursor's string payload. SQLite
 * compares numbers before text, and maps false/true to 0/1; a text-bound
 * number or a stringified boolean would not resume the same ordering. */
export function propertySortValue(
  properties: Record<string, unknown>,
  sort: ReturnType<typeof parseSortField>,
): string | null {
  if (sort.kind !== "property") return null;
  const value = properties[sort.field];
  return isScalar(value) ? JSON.stringify(value) : null;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function propertySortBound(encoded: string): string | number {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
  if (!isScalar(value)) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
  return typeof value === "boolean" ? Number(value) : value;
}

/** SQLite preserves exact int64 JSON integers, while the API and cursor read
 * JavaScript doubles. Normalize numbers to REAL so ordering and cursor bounds
 * agree even outside the safe integer range. Objects and arrays share the
 * null tail with missing and null fields, matching propertySortValue. */
export function buildPropertySortExpr(
  propertiesCol: unknown,
  field: string,
): SQL {
  const path = "$." + field;
  return sql`CASE WHEN json_type(${propertiesCol}, ${path}) IN ('integer', 'real') THEN CAST(json_extract(${propertiesCol}, ${path}) AS REAL) WHEN json_type(${propertiesCol}, ${path}) IN ('text', 'true', 'false') THEN json_extract(${propertiesCol}, ${path}) ELSE NULL END`;
}
