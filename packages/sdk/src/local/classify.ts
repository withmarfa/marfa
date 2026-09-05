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
  /** Parked, with the reason the app can show. What clears it is the
   *  reason's business rather than this verdict's: a suspended space and an
   *  exhausted quota pass on their own, a write awaiting review does not. */
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
  /**
   * The server refused the write because the properties do not match the
   * type.
   *
   * Its own member rather than a `permanent`, because the client's copy of
   * the type graph may simply be older than the server's — a type
   * registered or widened on another device is one this store has never
   * read. So the first such refusal buys one `GET /types` and one local
   * revalidation, and only the refusal after that is final. Without the
   * distinction a client with a stale graph dead-letters writes that the
   * server would accept as soon as it knew what the server knows.
   */
  | { class: "schema"; code: string; httpStatus: number; message: string }
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
 * A refusal about the key rather than the row: it has already been
 * answered for a different body.
 *
 * Read by code rather than by status. The same status carries refusals
 * this engine's writes cannot produce, and classifying by status alone
 * would bucket them all without anyone having checked which a mutation
 * can actually meet.
 */
const KEY_REUSED = "idempotency_key_reused";

/**
 * A repeat resolved a key whose stored result is no longer held.
 *
 * The server kept the key, so it will not perform the write a second time,
 * and it lost the answer, so it cannot say what the first attempt did. The
 * client therefore cannot learn whether its write landed, and nothing it
 * does on its own will change that.
 *
 * Neither of the obvious readings is honest. Retrying gets this same
 * answer for ever, because the record is not coming back. Dead-lettering
 * tells the app a write was refused when it may well have succeeded, and a
 * person shown that would reasonably make the edit again. So it parks for
 * review, on the same grounds as a base the server can no longer merge
 * against: the server cannot tell you, and you must not guess.
 */
const RESULT_NOT_RETAINED = "idempotency_result_not_retained";

/**
 * The codes the server answers when an item's properties do not match its
 * type. Two of them, for one refusal.
 *
 * Both doors run the same validation over the same schema and wrap the
 * same error list; they differ only in which layer raises it. Creating an
 * item raises the storage layer's generic validation code; updating,
 * upserting, bulk-writing and the strict-mode pre-check raise the route
 * layer's specific invalid-properties code. The specific one is what the
 * contract means and what the server is settling on, and the create path
 * is the odd one out.
 *
 * Both are accepted here rather than only the specific one, because a
 * classification that recognized one and not the other would be wrong in
 * both directions at once: a create refused on schema grounds would fall
 * through to the generic 400 arm and be dead-lettered without the registry
 * refresh it is owed, while a client taught only the generic code would
 * read unrelated validation failures as schema ones. Accepting both costs
 * nothing once the split closes — the generic code stops arriving from
 * this door, and this set stops needing its second member.
 */
const SCHEMA_REFUSAL_CODES = new Set([
  "validation_error",
  "invalid_properties",
]);

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

  // The key is spent, not the write.
  //
  // The engine can send a different body under one key: the drain reads
  // the version from its local mirror at drain time, so a transient
  // failure followed by an inbound event puts a new version in the
  // request while the key stays as it was written.
  //
  // Neither obvious reading is honest. Transient retries to the ceiling
  // and then tells a person the write "ran out of retries", for one
  // refused on its first attempt and on every attempt after. Permanent
  // dead-letters an edit that is still wanted — the key is spent, the
  // intent is not. So it parks with its reason, which is what this
  // classification already does for a suspended space and for the same
  // reason: a refusal that is neither the write's fault nor forever.
  //
  // This is rule 5 applied rather than excepted. "Everything else is
  // transient" is the default for a status whose meaning the client
  // cannot determine; a refusal whose code the client can read and act
  // on was never in that set.
  //
  // Freezing the body to the key was considered and does not work:
  // recomputing the version is exactly what a correct client must do
  // when an inbound event moves the row, so a frozen version would
  // remove this refusal by guaranteeing a version conflict instead.
  // Whether a rebased mutation should carry a new key is open, with a
  // ticket and a measurement against it.
  if (code === KEY_REUSED) {
    return { class: "blocked", reason: "needs_review", message };
  }

  if (code === RESULT_NOT_RETAINED) {
    return { class: "blocked", reason: "needs_review", message };
  }

  // An update the server would not settle.
  //
  // The obvious case is no longer reachable from the drain: it sends
  // `conflict=auto`, so a base the row has moved past is merged rather
  // than refused. What still arrives here is narrower and worth naming,
  // because the bucket looks unchanged while its contents have moved.
  //
  // `ancestor_unavailable` — the base version's snapshot has been thinned
  // past merging. Never auto-resolved, by design, and parking is the only
  // honest answer.
  //
  // `type_mismatch` — the drain sends `type` from its local mirror of
  // server state, and a stale mirror earns a 409. That one is recoverable
  // rather than permanent, which is why it parks with the edit intact
  // instead of dead-lettering: the mirror catches up and the write is
  // still wanted. Dead-lettering it would discard a write that would
  // succeed on the next pass.
  //
  // A caller sending `manual` or `callback` still meets the ordinary
  // version conflict here too. The engine may resolve none of them.
  if (status === 409 && kind.endsWith(".update")) {
    return { class: "conflict", code, httpStatus: status, message };
  }

  // A schema refusal, on either of the two codes the server answers it
  // with. Not permanent yet: the local graph gets one refresh and one
  // revalidation first, and the drain is what spends it.
  if (status === 400 && SCHEMA_REFUSAL_CODES.has(code)) {
    return { class: "schema", code, httpStatus: status, message };
  }

  // Every other 400, including `unknown_type`. A refresh does nothing for
  // that one: it says the *server* has no such type, and reading the
  // server's vocabulary again cannot change the server's answer. Only a
  // refusal about properties against a type is worth a second look, and it
  // is handled above.
  //
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
