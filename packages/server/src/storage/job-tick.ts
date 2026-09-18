/**
 * How a periodic background job reports a tick that did not finish.
 *
 * A tick cut short because the process is going away has not failed. Every
 * background job is stopped before the storage client closes, so a query
 * still in flight loses its client and rejects. Nothing is lost and nothing
 * is actionable: the next start runs the sweep again.
 *
 * Reporting that at `error` spends the level a fleet alert counts on an
 * event nobody can act on, and a category that is mostly routine deploys is
 * a category whoever reads it learns to discount. The two cases are
 * separable without guessing, because only a cancelled tick is both
 * client-closed-shaped and preceded by the job's own `stop()`. Anything
 * else, including a closed client while the job is still running, keeps
 * `error`.
 */

import { log } from "../middleware/logger.js";

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
 * Report a failed tick at the level it deserves. `job` names the job in
 * sentence case, as it appears in its success line, so the two read as one
 * family: `Revoked key reap` becomes `Revoked key reap error` or
 * `Revoked key reap stood down`.
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
