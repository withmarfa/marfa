/**
 * How the housekeeping scheduler reports a run that did not finish.
 *
 * A run cut short because the process is going away has not failed. The
 * scheduler is stopped before the storage client closes, so a query still
 * in flight loses its client and rejects. Nothing is lost and nothing is
 * actionable: the job is due again whenever its row says.
 *
 * Reporting that at `error` spends the level a fleet alert counts on an
 * event nobody can act on, and a category that is mostly routine deploys is
 * a category whoever reads it learns to discount. The two cases are
 * separable without guessing, because only a canceled run is both
 * client-closed-shaped and preceded by the scheduler's own `stop()`.
 * Anything else, including a closed client while the scheduler is still
 * running, keeps `error`.
 */

import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";

/**
 * What libsql raises when a query reaches a client that `close()` has
 * already been called on: a `LibsqlError` carrying this code.
 */
const CONNECTION_LOST_CODES = new Set(["CLIENT_CLOSED"]);

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
 * True when the failure describes the client going away rather than the
 * statement being wrong. Follows the causal chain, since a wrapped failure
 * carries the code on its cause.
 */
export function isConnectionLostError(err: unknown): boolean {
  return hasConnectionLostCode(err);
}

/**
 * Report a failed run at the level it deserves. `job` names what failed,
 * and the line is that name plus its fate: `Housekeeping trash-purge`
 * becomes `Housekeeping trash-purge error` or `Housekeeping trash-purge
 * stood down`.
 */
export function logJobTickFailure(
  job: string,
  err: unknown,
  stopped: boolean,
): void {
  const error = errorMessage(err);
  if (stopped && isConnectionLostError(err)) {
    log("info", `${job} stood down`, { error });
    return;
  }
  log("error", `${job} error`, { error });
}
