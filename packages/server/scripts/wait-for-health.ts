/**
 * The readiness probe the boot smoke polls with, extracted so it can be
 * tested and so a failure can say what it hit.
 *
 * It exists as its own module for one reason: the smoke script runs its
 * `main()` at import time, so nothing could import the loop to test it.
 * The loop was previously inline, and every attempt's diagnostic went into
 * a bare `catch` that slept and moved on — so a starved server, a refused
 * connection and a non-200 response all produced the identical report,
 * naming the outcome and showing the boot log. That cost a real diagnosis:
 * roughly twenty-seven attempts produced no evidence of what any of them
 * hit, and only reproducing the whole thing locally could separate a
 * server too slow to answer from one that was never listening.
 */

/**
 * How long one attempt may hang, derived from the caller's budget rather
 * than chosen: a single stuck request must not be able to eat the whole
 * readiness window, so it is capped at a thirtieth of it. That leaves at
 * least thirty samples in the worst case where every attempt hangs to its
 * ceiling, which is what makes the reported last attempt a description of
 * a steady state rather than of one unlucky moment.
 */
export function attemptTimeoutMs(budgetMs: number): number {
  return Math.max(1, Math.round(budgetMs / 30));
}

/**
 * One line saying what an attempt hit. The distinction that matters is
 * between a response that arrived and said no, and no response at all —
 * those have opposite causes and the old report could not tell them apart.
 */
export function describeAttempt(outcome: unknown): string {
  if (outcome instanceof Response) {
    return `HTTP ${String(outcome.status)}${outcome.statusText ? ` ${outcome.statusText}` : ""}`;
  }
  if (outcome instanceof Error) {
    // `cause` is where undici puts the socket-level reason, and it is the
    // half that names a refused connection or a wrong port. Without it
    // every network failure reads as a bare "fetch failed".
    const cause = outcome.cause;
    const causeText =
      cause instanceof Error
        ? ` (${cause.name}: ${cause.message})`
        : typeof cause === "string" || typeof cause === "number"
          ? ` (${String(cause)})`
          : "";
    return `${outcome.name}: ${outcome.message}${causeText}`;
  }
  if (typeof outcome === "string") return outcome;
  // Deliberately not `String(outcome)`, which renders a plain object as
  // "[object Object]" — the uninformative report this whole change exists
  // to stop producing. Naming the type at least says what arrived.
  return `a thrown ${typeof outcome} carrying no message`;
}

export interface HealthWaitResult {
  ok: boolean;
  attempts: number;
  /** What the final attempt hit, or why the wait was abandoned. */
  lastOutcome: string;
  /** Set when `shouldStop` ended the wait rather than the budget. */
  stoppedEarly: boolean;
}

/**
 * Poll `url` until it answers 200 or the budget runs out.
 *
 * `shouldStop` lets the caller abandon the wait for a reason the probe
 * cannot see — the boot smoke uses it to notice the child process exiting,
 * which is a different failure from an endpoint that never answers and
 * deserves to be reported as one.
 */
export async function waitForHealth(opts: {
  url: string;
  budgetMs: number;
  pollIntervalMs?: number;
  shouldStop?: () => string | null;
}): Promise<HealthWaitResult> {
  const { url, budgetMs, pollIntervalMs = 250, shouldStop } = opts;
  const perAttempt = attemptTimeoutMs(budgetMs);
  const deadline = Date.now() + budgetMs;
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  let attempts = 0;
  let lastOutcome = "no attempt was made before the budget expired";

  while (Date.now() < deadline) {
    const stop = shouldStop?.();
    if (stop !== undefined && stop !== null) {
      return { ok: false, attempts, lastOutcome: stop, stoppedEarly: true };
    }
    attempts += 1;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(perAttempt) });
      if (res.ok) {
        return {
          ok: true,
          attempts,
          lastOutcome: describeAttempt(res),
          stoppedEarly: false,
        };
      }
      lastOutcome = describeAttempt(res);
    } catch (err: unknown) {
      lastOutcome = describeAttempt(err);
    }
    await sleep(pollIntervalMs);
  }

  return { ok: false, attempts, lastOutcome, stoppedEarly: false };
}
