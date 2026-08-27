/**
 * The Postgres half of the boot-time stored-value scan: one aggregate per
 * scanned column.
 *
 * Its own file rather than a closure inside `index.ts` so a test can run
 * the query the boot runs. The integration leg of
 * `stored-value-scan.test.ts` is the one case that proves the SQL, and it
 * proves nothing if it restates it.
 */
import type { ColumnValueCounts } from "../stored-value-scan.js";

/**
 * A query function over the raw client, which is all this needs.
 *
 * Narrower than `PgClient` on purpose: the test reaches the same query
 * through the storage layer's `__pgClient` escape hatch, and a parameter
 * typed to the driver handle would have forced it to build its own.
 */
export type PgUnsafeQuery = (sql: string) => Promise<unknown[]>;

/**
 * Builds the seam `scanStoredValues` calls.
 *
 * **One aggregate per column, not a row scan and not `SELECT DISTINCT`.**
 * `items.state` is the only one of these that scales and it is indexed in
 * both dialects (`idx_items_state`), so this plans as an index-only scan.
 * `DISTINCT ... WHERE NOT IN (...)` is the same work with a worse plan and
 * throws the count away, which is the number an operator needs to tell one
 * restored row from a whole table.
 *
 * The identifiers are interpolated because they are identifiers, which no
 * driver parameterizes. They come from `SCANNED_COLUMNS`, a module
 * constant with no path from any request, and they are quoted so a column
 * added there cannot collide with a keyword.
 *
 * `COUNT(*)` is `bigint`, which postgres-js hands back as a string. Cast
 * in the query rather than parsed at the call site so the seam's contract
 * is the same number in both dialects, and coerced again on the way out
 * because the driver's row type is `unknown` and asserting a number there
 * would be the same unchecked claim this whole module exists to count.
 */
export function pgStoredValueCounts(query: PgUnsafeQuery): ColumnValueCounts {
  return async (table, column) => {
    const rows = (await query(
      `SELECT "${column}" AS value, COUNT(*)::int AS count
         FROM "${table}"
        GROUP BY "${column}"`,
    )) as { value: unknown; count: unknown }[];
    return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
  };
}
