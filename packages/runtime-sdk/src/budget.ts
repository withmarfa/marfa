/**
 * How much of its allowance a running dispatch has left.
 *
 * A dispatch is bounded, and until now nothing told a handler so. The
 * bound was undocumented, unreachable from handler code, and enforced by
 * the queue taking the job back rather than by anything stopping the run,
 * so a handler had no way to finish tidily and every integration invented
 * its own answer.
 *
 * `shouldYield` is a boolean rather than a countdown, and that is a
 * decision rather than a simplification. A number becomes part of the
 * contract: authors branch on it, compare it, and subtract from it, and
 * the runtime can then never move it. A boolean says only "wrap up", which
 * is the one thing a handler can act on, and leaves the runtime free to
 * change how it decides.
 *
 * The clocks it sits between, because they have to stay in this order:
 *
 * - The **soft deadline** is what this exposes, and it is well inside the
 *   dispatch bound so that a parking handler has time to commit.
 * - The **dispatch bound** is when the queue reclaims the job. A run past
 *   it is recorded as a failure rather than a sync, however it reports.
 * - The **credential** outlives both, because it is minted after the job
 *   goes active and carries a margin over the bound. That ordering is what
 *   keeps the asymmetry below from biting.
 *
 * **Why the ordering is load-bearing.** A handler's cursor writes go
 * through an in-thread map and need no credential; its item writes and its
 * activity rows share one that expires. Past expiry the item writes fail
 * while the cursor writes keep succeeding, so a run that kept going would
 * advance its position over records it could no longer write and strand
 * them — and could not report that it was failing, because the reporting
 * channel died with the same credential. Yielding well before the bound
 * keeps a run away from that edge rather than relying on it never arriving.
 */
export interface Budget {
  /**
   * True once the runtime wants the handler to stop taking new work and
   * return. The thing a page loop polls.
   */
  readonly shouldYield: boolean;
  /**
   * Aborts at the soft deadline, so a provider call already in flight
   * when it passes is not what carries the run past the dispatch bound.
   *
   * **The runtime already applies it to `ctx.marfa.proxyRequest`**, which
   * is the path integrations reach a provider through, so there is
   * nothing to thread through your own call sites. Pass it explicitly
   * only to a `fetch` you make yourself.
   *
   * **Not applied to this client's own Marfa calls, deliberately.** The
   * soft deadline is when a handler is asked to wrap up, and wrapping up
   * means writing: a last page of items, an activity row, the cursor.
   * Aborting those would cut off the commit the deadline exists to leave
   * room for.
   */
  readonly signal: AbortSignal;
  /**
   * Milliseconds until the soft deadline, floored at zero.
   *
   * For diagnostics and for an author deciding whether one more page is
   * worth starting. Branching on it rather than on `shouldYield` puts the
   * runtime's arithmetic in the handler, which is what the boolean exists
   * to avoid.
   */
  remainingMs(): number;
}

/** What the runtime needs to build a budget for one dispatch. */
export interface BudgetInput {
  /**
   * When the supervisor picked this dispatch up, epoch ms.
   *
   * The supervisor's clock rather than the worker thread's, because queue
   * latency, lock acquisition and the credential mint all happen before a
   * handler starts and are all charged against the bound. Anchoring on
   * thread start would hand a handler an allowance the queue has already
   * partly spent.
   */
  startedAtMs: number;
  /** Milliseconds from `startedAtMs` to the soft deadline. */
  softLimitMs: number;
  /** Clock, injectable so a test need not spend the real allowance. */
  now?: () => number;
}

/**
 * Build a budget and the controller that arms it.
 *
 * The controller is returned rather than hidden so the caller can abort
 * on its own account — a worker being torn down should abort in-flight
 * calls whether or not the deadline has passed.
 */
export function createBudget(input: BudgetInput): {
  budget: Budget;
  controller: AbortController;
  /** Arm the deadline. Returns a cancel for the timer it starts. */
  arm: () => () => void;
} {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  // Refused rather than tolerated, because the failure is silent and the
  // symptom is absurd. `undefined + undefined` is NaN; `NaN >= NaN` is
  // false, so `remainingMs()` returns NaN, and `setTimeout(fn, NaN)`
  // fires after one millisecond — so a handler handed a malformed budget
  // is told to yield almost immediately, on every dispatch, forever, and
  // nothing anywhere reports a fault. Two callers built this request by
  // shape rather than through the type and sent neither number; both
  // stayed green.
  if (
    !Number.isFinite(input.startedAtMs) ||
    !Number.isFinite(input.softLimitMs)
  ) {
    throw new TypeError(
      `createBudget needs two finite numbers; got startedAtMs=${String(input.startedAtMs)}, softLimitMs=${String(input.softLimitMs)}`,
    );
  }
  const deadlineMs = input.startedAtMs + input.softLimitMs;

  const budget: Budget = {
    get shouldYield() {
      return controller.signal.aborted || now() >= deadlineMs;
    },
    signal: controller.signal,
    remainingMs() {
      return Math.max(0, deadlineMs - now());
    },
  };

  const arm = (): (() => void) => {
    // Already past it when the handler starts, which a backed-up queue can
    // produce: yield immediately rather than granting a full allowance
    // measured from now.
    const delay = Math.max(0, deadlineMs - now());
    const timer: unknown = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
    }, delay);
    // A dispatch must not be held open by its own deadline timer. `unref`
    // is Node's and this package deliberately avoids Node-only globals —
    // it decodes base64 by hand rather than reaching for `Buffer` — so the
    // call is guarded rather than assumed. Where it does not exist there
    // is nothing to hold open in the first place.
    (timer as { unref?: () => void }).unref?.();
    return () => {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    };
  };

  return { budget, controller, arm };
}
