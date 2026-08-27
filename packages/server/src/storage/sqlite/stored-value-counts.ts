/**
 * The SQLite half of the boot-time stored-value scan: one aggregate per
 * scanned column.
 *
 * Its own file for the same reason as the Postgres sibling — see
 * `pg/stored-value-counts.ts` for the design notes and for why this is an
 * aggregate rather than a `SELECT DISTINCT`.
 */
import type { ColumnValueCounts } from "../stored-value-scan.js";

/**
 * A query function over the raw libsql client, which is all this needs.
 * The test reaches the same query through the storage layer's
 * `__sqliteAll` escape hatch.
 */
export type SqliteAllQuery = (sql: string) => Promise<unknown[]>;

/**
 * Builds the seam `scanStoredValues` calls.
 *
 * The identifiers are interpolated because they are identifiers. They come
 * from `SCANNED_COLUMNS`, a module constant with no path from any request,
 * and they are quoted so a column added there cannot collide with a
 * keyword.
 */
export function sqliteStoredValueCounts(
  query: SqliteAllQuery,
): ColumnValueCounts {
  return async (table, column) => {
    const rows = (await query(
      `SELECT "${column}" AS value, COUNT(*) AS count
         FROM "${table}"
        GROUP BY "${column}"`,
    )) as { value: unknown; count: unknown }[];
    return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
  };
}
