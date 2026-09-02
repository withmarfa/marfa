/**
 * Detect a primary-key collision on a table's `id`.
 *
 * Happens when a caller supplies an explicit `id` that already exists in
 * ANOTHER space — the space-scoped pre-checks miss it because every one
 * of these primary keys is `id` alone, not `(space_id, id)`. Callers
 * surface it as a clean `CONFLICT` (409) instead of an opaque 500.
 *
 * PG raises `23505` against the table's pkey constraint, which is named
 * after the table. The constraint name is checked before the message
 * because a message match is the fallback for drivers that do not
 * populate it.
 *
 * One function rather than one per store — see the SQLite sibling for
 * why the rule belongs to the dialect rather than to the table.
 */
export function isPrimaryKeyViolation(
  err: unknown,
  table: "items" | "edges",
): boolean {
  const pkey = `${table}_pkey`;
  const cause =
    err != null && typeof err === "object"
      ? (err as { cause?: unknown }).cause
      : undefined;
  for (const layer of [err, cause]) {
    if (layer == null || typeof layer !== "object") continue;
    const e = layer as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
    };
    const code = typeof e.code === "string" ? e.code : "";
    const constraint =
      typeof e.constraint_name === "string" ? e.constraint_name : "";
    const message = typeof e.message === "string" ? e.message : "";
    // `items` carries a second unique index, and a collision on it is a
    // duplicate natural key rather than a duplicate id. It has its own
    // error and must not be reported as this one.
    if (table === "items") {
      if (constraint === "idx_items_source_dedup") return false;
      if (message.includes("idx_items_source_dedup")) return false;
    }
    if (code === "23505" && constraint === pkey) return true;
    if (code === "23505" && message.includes(pkey)) return true;
  }
  return false;
}
