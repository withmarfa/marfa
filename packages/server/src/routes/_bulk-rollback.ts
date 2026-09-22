import { ErrorCode, MarfaError } from "@withmarfa/shared";

/**
 * The codes that make a rolled-back page a permission refusal.
 *
 * Named rather than derived from the status a code maps to, because two
 * other `403`s are not this: `core_type_immutable` and `connector_owned`
 * are facts about the row, and a caller told to ask for a permission it
 * would not be given either is sent somewhere there is nothing to get.
 */
const PERMISSION_REFUSALS: ReadonlySet<string> = new Set([
  ErrorCode.FORBIDDEN,
  ErrorCode.TYPE_NOT_PERMITTED,
  ErrorCode.EDGE_PERMISSION_DENIED,
  ErrorCode.SCOPED_CREDENTIAL_NOT_PERMITTED,
]);

/**
 * The refusal an atomic page rolls back with, taking its status from the
 * entry that caused it.
 *
 * The code stays `bulk_atomic_rollback` on every one of them, because
 * what happened to the page is the same whatever refused it and a client
 * that unwinds a rollback does so identically. What the status says is
 * something else: whether the caller can fix this by changing the
 * request. It cannot, where the entry was refused a permission, and a
 * `400` there puts a permissions failure in the pile a caller re-reads
 * its own body over.
 */
export function bulkAtomicRollback(
  index: number,
  inner: {
    code: string | undefined;
    message: string | undefined;
    details?: Record<string, unknown>;
  },
  what: "upsert" | "edge" = "upsert",
): MarfaError {
  const noun = what === "edge" ? "edge" : "item";
  return new MarfaError(
    ErrorCode.BULK_ATOMIC_ROLLBACK,
    `Bulk ${what} rolled back on ${noun} ${String(index)}`,
    {
      index,
      code: inner.code,
      message: inner.message,
      ...(inner.details && { details: inner.details }),
    },
    inner.code !== undefined && PERMISSION_REFUSALS.has(inner.code)
      ? 403
      : undefined,
  );
}
