import { MarfaError } from "../errors.js";
import type { BlockedReason } from "./types.js";

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

export function classifyFailure(error: unknown): Verdict {
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

  // 400 covers validation and the schema refusals. The contract's one
  // registry refresh and revalidation before a schema refusal counts as
  // permanent needs a local type registry, which this engine does not carry
  // yet; until it does, a schema refusal is treated like any other 400.
  // 403 and 404 are the caller's authority and the row's existence, neither
  // of which a retry changes. A 409 on a create means the id is held
  // elsewhere; on an update it is a conflict the client's own resolution
  // could not settle, which is a refusal rather than something to repeat.
  if (status === 400 || status === 403 || status === 404 || status === 409) {
    return { class: "permanent", code, httpStatus: status, message };
  }

  // A rate limit is a wait rather than a refusal, so it lands here with the
  // 5xx family.
  return { class: "transient", message };
}
