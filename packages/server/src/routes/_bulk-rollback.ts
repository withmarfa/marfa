import { ErrorCode, MarfaError, httpStatus } from "@withmarfa/shared";

/**
 * Whether the refusal that rolled the page back is one the caller cannot
 * fix by changing the request.
 *
 * Asked of the code's own status rather than of a list of codes, and the
 * list is what the first draft had. Enumerating "the permission ones"
 * means judging each `403` — is `connector_owned` a permission, or a fact
 * about the row? — and every judgement is a way for one door to answer
 * `403` where its sibling answers `400` for the same mistake, which is
 * the disagreement this whole change exists to remove. A `403` is a
 * `403`, and `STATUS_MAP` already says which codes are.
 */
function isForbidden(code: string): boolean {
  return httpStatus(code as ErrorCode) === 403;
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
 * Asked of the status rather than of a list of codes, for the reason
 * `isForbidden` below is: a list is a judgement per code, and every
 * judgement is a way for one door to disagree with its sibling.
 */
export function isEntryVerdict(err: unknown): err is MarfaError {
  return err instanceof MarfaError && err.status < 500;
}

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
    inner.code !== undefined && isForbidden(inner.code) ? 403 : undefined,
  );
}
