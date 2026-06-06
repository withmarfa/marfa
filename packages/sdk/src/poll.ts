/**
 * Generic exponential-backoff poll helper used by
 * `client.items.bulkAction` to drive async-job lifecycles.
 *
 * Reusable across async-job endpoints — the default 250 → 500 → 1000
 * → 2000ms schedule suits a job-table-backed substrate where the worker
 * picks up a new job within ~500ms of the INSERT. Callers can tune via
 * `pollIntervalMs` / `maxWaitMs` / `maxPollIntervalMs`.
 */

export interface PollOptions {
  /** Initial poll interval in ms. Doubles on each tick until
   *  `maxPollIntervalMs`. Default 250ms. */
  pollIntervalMs?: number;
  /** Ceiling for the backoff. Default 2000ms. */
  maxPollIntervalMs?: number;
  /** Total poll budget in ms. Throws `PollTimeoutError` past this.
   *  Default 30 minutes (matches the server's
   *  `MAX_BULK_ACTION_ITEMS_HARD` worst-case wall-clock). */
  maxWaitMs?: number;
  /** Callback after each poll attempt. Receives the result the
   *  `isTerminal` check returned `false` for — useful for surfacing
   *  progress to a UI. */
  onProgress?: (result: never) => void;
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

export class PollTimeoutError extends Error {
  readonly code = "poll_timeout";
  readonly waited: number;
  constructor(waited: number) {
    super(`Poll timed out after ${String(waited)}ms`);
    this.waited = waited;
    this.name = "PollTimeoutError";
  }
}

export interface PollHookOptions<T> {
  fetchOnce: () => Promise<T>;
  isTerminal: (result: T) => boolean;
  onProgress?: (result: T) => void;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  maxWaitMs?: number;
}

/** Poll until `isTerminal` returns true or the budget is exhausted.
 *  The first `fetchOnce` runs immediately (no initial delay). Each
 *  subsequent attempt waits the current interval, then the interval
 *  doubles up to `maxPollIntervalMs`. */
export async function pollUntilTerminal<T>(
  opts: PollHookOptions<T>,
): Promise<T> {
  const startInterval = opts.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
  const maxInterval = opts.maxPollIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const start = Date.now();
  let interval = startInterval;

  for (;;) {
    const result = await opts.fetchOnce();
    if (opts.isTerminal(result)) return result;
    opts.onProgress?.(result);

    const elapsed = Date.now() - start;
    if (elapsed >= maxWait) {
      throw new PollTimeoutError(elapsed);
    }

    const sleep = Math.min(interval, maxWait - elapsed);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, sleep);
    });
    interval = Math.min(interval * 2, maxInterval);
  }
}
