/**
 * Generic exponential-backoff poll helper used by
 * `client.items.bulkAction` to drive async-job lifecycles.
 *
 * Reusable across async-job endpoints — the default 250 → 500 → 1000
 * → 2000ms schedule suits a job table whose worker picks up a new row
 * within ~500ms of the INSERT. Callers can tune via
 * `pollIntervalMs` / `maxWaitMs` / `maxPollIntervalMs`.
 */

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
  /** Whether a thrown `fetchOnce` should be waited out rather than
   *  ending the poll. Absent, any throw ends it, which is the right
   *  default for a caller that cannot say which failures are transient.
   *
   *  **A poll asks about work that is already running.** The question
   *  failing is not the work failing, so a predicate that recognizes a
   *  transport-level failure turns a slow answer into a delay rather
   *  than into a reported failure for a job that is still going. The
   *  wall-clock budget still bounds it: a retry is not free time. */
  isRetryable?: (error: unknown) => boolean;
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
    let result: T;
    try {
      result = await opts.fetchOnce();
    } catch (err) {
      if (!opts.isRetryable?.(err)) throw err;
      // The budget is checked before sleeping rather than before
      // retrying, so the failure the caller finally sees is the last
      // real one instead of a `PollTimeoutError` that says nothing
      // about why the answer never came.
      if (Date.now() - start >= maxWait) throw err;
      await sleepFor(Math.min(interval, maxWait - (Date.now() - start)));
      interval = Math.min(interval * 2, maxInterval);
      continue;
    }
    if (opts.isTerminal(result)) return result;
    opts.onProgress?.(result);

    const elapsed = Date.now() - start;
    if (elapsed >= maxWait) {
      throw new PollTimeoutError(elapsed);
    }

    await sleepFor(Math.min(interval, maxWait - elapsed));
    interval = Math.min(interval * 2, maxInterval);
  }
}

function sleepFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
