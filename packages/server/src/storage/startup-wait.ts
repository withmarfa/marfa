/**
 * Bounded wait for the database at boot.
 *
 * The failure this exists for: a supervised server restarts after a
 * reboot, Postgres comes back slower than the server, the first
 * connection attempt fails, the process exits, and the supervisor
 * relaunches it into the same window every few seconds — a crash loop
 * that once ran for eighteen days with nothing watching. Waiting with
 * backoff inside the process turns that into a few loud log lines and a
 * clean start.
 *
 * Only connection-shaped failures wait. A misconfiguration (a bad pool
 * mode, a malformed URL, an auth failure) reproduces identically on
 * every attempt, and retrying it would only bury the real error under a
 * budget of noise, so those still fail immediately.
 */

const RETRYABLE_CODES = new Set([
  // Network-shaped: the database is not answering (yet).
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  // Postgres 57P03: "the database system is starting up" — the exact
  // slow-restart window this module exists for.
  "57P03",
  // Postgres 53300: too many connections — transient under a thundering
  // herd of restarting services.
  "53300",
]);

export function isRetryableDbError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
  // postgres.js wraps some connect failures without a code; fall back to
  // the causal chain.
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) return isRetryableDbError(cause);
  return false;
}

export interface StartupWaitOptions {
  /** Total budget in ms. `0` disables waiting (single attempt). */
  budgetMs: number;
  /** Called before each retry sleep with the attempt number and delay. */
  onAttempt?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Injectable clock for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;

/**
 * Runs `fn`, retrying on retryable database errors with capped
 * exponential backoff until the budget is spent. Non-retryable errors
 * and budget exhaustion rethrow the last error unchanged so the caller's
 * failure path stays exactly what it was.
 */
export async function withStartupWait<T>(
  fn: () => Promise<T>,
  opts: StartupWaitOptions,
): Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.budgetMs;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (opts.budgetMs <= 0 || !isRetryableDbError(err)) throw err;
      const delay = Math.min(
        BACKOFF_START_MS * 2 ** (attempt - 1),
        BACKOFF_CAP_MS,
      );
      if (Date.now() + delay > deadline) throw err;
      opts.onAttempt?.(attempt, delay, err);
      await sleep(delay);
    }
  }
}
