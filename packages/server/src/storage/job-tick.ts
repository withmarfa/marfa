/**
 * How a periodic background job reports a tick that did not finish.
 *
 * A tick cut short because the process is going away has not failed. Every
 * background job is stopped before the storage pool closes, so a query still
 * in flight loses its connection and rejects. Nothing is lost and nothing is
 * actionable: the next start runs the sweep again.
 *
 * Reporting that at `error` spends the level a fleet alert counts on an
 * event nobody can act on, and a category that is mostly routine deploys is
 * a category whoever reads it learns to discount. The two cases are
 * separable without guessing, because only a cancelled tick is both
 * connection-shaped and preceded by the job's own `stop()`. Anything else,
 * including a connection failure while the job is still running, keeps
 * `error`.
 */

import { log } from "../middleware/logger.js";
import { isRetryableDbError } from "./startup-wait.js";

/**
 * What postgres.js raises when a query loses its connection rather than
 * failing on its own merits: `end()` rejects everything still in flight,
 * and a socket that closes underneath a query reports the same way. These
 * are deliberately not folded into the boot-time retryable set, which
 * answers a different question — whether a database that has not answered
 * yet is worth waiting for.
 */
const CONNECTION_LOST_CODES = new Set([
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_CLOSED",
]);

function hasConnectionLostCode(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_LOST_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err
    ? hasConnectionLostCode(cause)
    : false;
}

/**
 * True when the failure describes the connection going away rather than the
 * statement being wrong. Covers both directions: a pool closing under an
 * in-flight query, and the network-shaped failures the boot-time wait
 * already recognizes.
 */
export function isConnectionLostError(err: unknown): boolean {
  return hasConnectionLostCode(err) || isRetryableDbError(err);
}

/**
 * Report a failed tick at the level it deserves. `job` names the job in
 * sentence case, as it appears in its success line, so the two read as one
 * family: `Runtime credential reap` becomes `Runtime credential reap error`
 * or `Runtime credential reap stood down`.
 */
export function logJobTickFailure(
  job: string,
  err: unknown,
  stopped: boolean,
): void {
  const error = err instanceof Error ? err.message : String(err);
  if (stopped && isConnectionLostError(err)) {
    log("info", `${job} stood down`, { error });
    return;
  }
  log("error", `${job} error`, { error });
}
