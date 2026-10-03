import { ErrorCode, MarfaError, httpStatus } from "@withmarfa/shared";
import { TransactionFailure } from "../storage/sqlite/transaction-control.js";

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

/** An unavailable commit witness is not evidence that the entry rolled back. */
export function isWriteOutcomeUnknown(err: unknown): boolean {
  return err instanceof TransactionFailure && err.control.outcome === "unknown";
}

/** A page must not invite replay after either a confirmed or possible commit. */
export function mayHaveCommitted(result: {
  outcome: "created" | "updated" | "skipped" | "errored";
  error?: { details?: Record<string, unknown> };
}): boolean {
  return (
    result.outcome === "created" ||
    result.outcome === "updated" ||
    result.error?.details?.write_outcome === "unknown"
  );
}

/** Keep possible commits visible in a partial answer without retrying the page. */
export function failedEntry(err: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (isWriteOutcomeUnknown(err))
    return {
      code: "internal_error",
      message:
        "The entry may have been written, but its commit could not be confirmed. Read its current state before retrying this entry; do not resend the whole page.",
      details: { write_outcome: "unknown" },
    };
  if (err instanceof MarfaError)
    return {
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    };
  return {
    code: "internal_error",
    message: "The entry could not be written, and nothing of it was",
  };
}

export function countOutcomes(
  results: readonly {
    outcome: "created" | "updated" | "skipped" | "errored";
  }[],
) {
  const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}
