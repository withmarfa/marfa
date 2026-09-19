/**
 * Detect a primary-key collision on a table's `id`.
 *
 * Happens when a caller supplies an explicit `id` that already exists.
 * A route's pre-checks can race a concurrent insert of the same id, so
 * the insert trips the constraint. Callers surface it as a clean
 * `CONFLICT` (409) instead of an opaque 500.
 *
 * Drizzle wraps the libsql error: the outer Error carries a "Failed
 * query" message with `code: undefined`, while the `cause` carries
 * `SQLITE_CONSTRAINT` plus the offending column in its message. Inspect
 * both.
 *
 * One function rather than one per store. The rule is the database's, not
 * the table's, and the tables that need it differ only in which name
 * appears in the message — so a copy per store is a copy of a rule, and
 * the one that got missed would be the one nobody noticed was a copy.
 */
export function isPrimaryKeyViolation(
  err: unknown,
  table: "items" | "edges",
): boolean {
  const cause =
    err != null && typeof err === "object"
      ? (err as { cause?: unknown }).cause
      : undefined;
  for (const layer of [err, cause]) {
    if (layer == null || typeof layer !== "object") continue;
    const e = layer as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    // `items` carries a second unique index, and a collision on it is a
    // duplicate natural key rather than a duplicate id. It has its own
    // error and must not be reported as this one.
    if (table === "items" && message.includes("idx_items_source_dedup")) {
      return false;
    }
    if (
      code.includes("SQLITE_CONSTRAINT") &&
      (message.includes(`${table}.id`) || message.includes("PRIMARY KEY"))
    ) {
      return true;
    }
  }
  return false;
}
