import { ErrorCode, MarfaError, httpStatus } from "@withmarfa/shared";

/**
 * The status the inner refusal carries on its own. Only a refusal of the
 * entry reaches a rollback, so anything outside `4xx` is a code this door
 * never meant to fold in, and it answers as a refusal of the body.
 */
function innerStatus(code: string | undefined): number {
  if (code === undefined) return 400;
  const status = httpStatus(code as ErrorCode) as number | undefined;
  return status !== undefined && status >= 400 && status < 500 ? status : 400;
}

/**
 * Whether this refusal is a verdict on the entry rather than on the
 * server, and so belongs in that entry's own `errored` outcome.
 *
 * A bad type, a stale version, a permission the caller does not hold:
 * each is a fact about the entry, the rest of the page is unaffected,
 * and reporting it beside the entry is the whole point of a
 * non-atomic page. A `5xx` is not that. `write_contention` says the
 * server could not write *this time* and the next attempt would land,
 * and folding it into a `200` tells a device — which retries a `5xx`
 * without counting it (`queue-and-verdicts.md` 17) — that there is
 * nothing to retry. Nothing was written and the page says it
 * succeeded.
 *
 * Asked of the status rather than of a list of codes: a list is a
 * judgement per code, and every judgement is a way for one door to
 * disagree with its sibling.
 */
export function isEntryVerdict(err: unknown): err is MarfaError {
  return err instanceof MarfaError && err.status < 500;
}

/**
 * The refusal an atomic page rolls back with, at the status of the entry's
 * refusal.
 *
 * The code stays `bulk_atomic_rollback` on every one of them, because
 * what happened to the page is the same whatever refused it and a client
 * that unwinds a rollback does so identically. The status says what the
 * caller does next: a `400` re-reads its body, a `403` lacks a permission,
 * a `404` names a row that is not there and a `409` names one that moved.
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
    innerStatus(inner.code),
  );
}

/**
 * A best-effort page's answer for an entry whose write failed for a reason
 * of the server's own (the event log refusing its row, the lock's budget, a
 * full disk) after earlier entries committed. Before any has, the failure
 * answers the page, nothing having been written. Answered as that entry's own
 * `errored` outcome, and the page as `200`, rather than failing the page:
 * a `5xx` tells the caller nothing was written, so it sends the page again
 * and the committed entries are written twice. No idempotency key stands in
 * the way: the bulk doors take none. The entry itself wrote nothing, its
 * transaction having rolled back.
 */
export function failedEntry(err: unknown): { code: string; message: string } {
  if (err instanceof MarfaError)
    return { code: err.code, message: err.message };
  return {
    code: "internal_error",
    message: "The entry could not be written, and nothing of it was",
  };
}
