import { MarfaError } from "../errors.js";
import type { BlockedReason, MutationKind } from "./types.js";

/**
 * What the engine does about a write that did not succeed.
 *
 * Closed, and deliberately so: an unclassified failure either retries for
 * ever or drops the write, and both are silent. Every member below says
 * what happens to the mutation, and between them they cover every way a
 * send can end.
 */
export type Verdict =
  /** Nothing was refused — the request never reached a server. Not an
   *  attempt, so it does not count towards the retry ceiling, and the pass
   *  stops rather than working through a queue nothing can send. */
  | { class: "offline"; message: string }
  /** The credential is spent. The transport has already made its one
   *  refresh, so this parks the whole queue rather than the one write that
   *  met it. */
  | { class: "auth"; message: string }
  /** Refused for a reason that will pass: a suspended space, an exhausted
   *  quota. The mutation waits with the reason the app can show. */
  | { class: "blocked"; reason: BlockedReason; message: string }
  /**
   * The server refused an update because the row had moved on, and did not
   * settle the conflict itself.
   *
   * Its own member rather than a `permanent` or a `blocked`, because it is
   * neither. Nothing is refused for good — the edit is still wanted, and
   * dead-lettering it would throw away work over a version number. And
   * waiting does not help either, so parking it beside a suspended space
   * would promise a recovery that never arrives: the base version the edit
   * was computed against is gone, and only the app re-applying the edit
   * over what the server now holds gets it moving.
   *
   * The distinction the code carries is worth keeping in front of the app.
   * A stale version means the current row is there to rebase onto; a base
   * whose snapshot has been thinned past merging means there is nothing to
   * compare against and the two versions have to be shown side by side.
   */
  | { class: "conflict"; code: string; httpStatus: number; message: string }
  /** Refused for good. The mutation dead-letters, and a refused create
   *  takes its dependants with it. */
  | {
      class: "permanent";
      code: string | null;
      httpStatus: number | null;
      message: string;
    }
  /** Everything else. Retries, to a ceiling, after which it parks. */
  | { class: "transient"; message: string };

/** Refusals whose stated cause is temporary. A 403 or a 429 says nothing
 *  about permanence on its own; the code does. */
const TEMPORARY_REFUSALS: Record<string, BlockedReason> = {
  space_suspended: "space_suspended",
  quota_exceeded: "quota_exceeded",
};

/** Failures the transport raises without a server having answered. */
const UNREACHABLE_CODES = new Set(["network_error", "timeout"]);

/**
 * A 409 that is about the key rather than about the row.
 *
 * The key names a request another arrival is still serving, so the write
 * has not been refused and nothing has been decided about it — asking
 * again is the response the server is inviting. Reading it as a conflict
 * would park a mutation that only needed a moment, and reading it as a
 * refusal on a create would dead-letter one the server may be about to
 * accept.
 */
const KEY_IN_FLIGHT = "idempotency_key_in_flight";

/**
 * Decide what becomes of a write the server did not accept.
 *
 * The mutation's kind is a parameter because one status means two things:
 * a 409 on a create says the id is held by a row this client did not make,
 * which no retry changes, while a 409 on an update says the row moved on
 * under an edit that is still wanted. Classifying on the status alone
 * cannot tell them apart, so it has to pick one and be wrong about the
 * other.
 */
export function classifyFailure(error: unknown, kind: MutationKind): Verdict {
  if (!(error instanceof MarfaError)) {
    const message = error instanceof Error ? error.message : String(error);
    return { class: "transient", message };
  }

  const { code, status, message } = error;

  if (status === 0) {
    if (UNREACHABLE_CODES.has(code)) return { class: "offline", message };
    // A status of zero with any other code means the request went out and
    // something local went wrong with the answer. Nothing was refused, so
    // the write is kept and tried again.
    return { class: "transient", message };
  }

  if (status === 401) return { class: "auth", message };

  const temporary = TEMPORARY_REFUSALS[code];
  if (temporary !== undefined) {
    return { class: "blocked", reason: temporary, message };
  }

  if (code === KEY_IN_FLIGHT) return { class: "transient", message };

  // An update the server would not settle. That covers a base version the
  // row has moved past, and a base whose snapshot has been thinned so far
  // that there is nothing left to merge against; the code says which, and
  // neither is something this engine may resolve on its own.
  if (status === 409 && kind.endsWith(".update")) {
    return { class: "conflict", code, httpStatus: status, message };
  }

  // 400 covers validation and the schema refusals. The contract's one
  // registry refresh and revalidation before a schema refusal counts as
  // permanent needs a local type registry, which this engine does not carry
  // yet; until it does, a schema refusal is treated like any other 400.
  // 403 and 404 are the caller's authority and the row's existence, neither
  // of which a retry changes. A 409 that got this far is on a create or a
  // delete, where it means the id is held by something this client did not
  // write — there is no version to rebase onto and nothing to review.
  if (status === 400 || status === 403 || status === 404 || status === 409) {
    return { class: "permanent", code, httpStatus: status, message };
  }

  // A rate limit is a wait rather than a refusal, so it lands here with the
  // 5xx family.
  return { class: "transient", message };
}
