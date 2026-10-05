import { TransactionFailure } from "./sqlite/transaction-control.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";

/**
 * Work that must happen once a transaction has committed and never if it
 * rolls back: telling this process's subscribers about a change whose event
 * row the transaction wrote.
 *
 * Each `storage.runInTransaction` opens a frame. A nested call is a
 * savepoint, so its frame's work joins its parent's only if the savepoint
 * is released, and is dropped with it otherwise; the outermost frame runs
 * its work after the commit. Work registered outside any transaction runs
 * at once, the write before it having already committed.
 */
interface Frame {
  pending: (() => void)[];
  state: "pending" | "committed" | "rolled_back" | "uncertain";
}

const frames = new AsyncLocalStorage<Frame>();
const roots: Frame[] = [];
const MAX_HELD_ROOT_FRAMES = 64;
const MAX_HELD_CALLBACKS = 10_000;
let deliveryUncertain: () => void = () => undefined;

export function onCommitDeliveryUncertain(listener: () => void): void {
  deliveryUncertain = listener;
}

function settle(
  frame: Frame,
  outcome: "committed" | "rolled_back" | "unknown",
): void {
  if (frame.state !== "pending" && frame.state !== "uncertain") return;
  if (outcome === "unknown" && frame.pending.length > 0) deliveryUncertain();
  frame.state = outcome === "committed" ? "committed" : "rolled_back";
  flushRoots();
}

function flushRoots(): void {
  while (roots[0]?.state === "committed" || roots[0]?.state === "rolled_back") {
    const frame = roots.shift();
    if (!frame) break;
    if (frame.state === "committed")
      for (const run of frame.pending) runSafely(run);
    frame.pending.length = 0;
  }
}

export async function withCommitHooks<T>(
  open: (body: () => Promise<T>) => Promise<T>,
  fn: () => T | Promise<T>,
  retainOnUncertain = false,
): Promise<T> {
  const parent = frames.getStore();
  const frame: Frame = { pending: [], state: "pending" };
  try {
    const result = await open(() => {
      // BEGIN retries can change writer order before this body is admitted.
      if (!parent) roots.push(frame);
      return frames.run(frame, async () => await fn());
    });
    if (parent) parent.pending.push(...frame.pending);
    else settle(frame, "committed");
    return result;
  } catch (error) {
    if (!parent) {
      if (
        error instanceof TransactionFailure &&
        error.control.outcome === "unknown" &&
        frame.pending.length > 0
      ) {
        if (retainOnUncertain) {
          frame.state = "uncertain";
          error.control.onReconciled((outcome) => {
            settle(frame, outcome);
          });
        } else settle(frame, "unknown");
      } else settle(frame, "rolled_back");
    }
    throw error;
  } finally {
    // A lost reconciliation must not retain an unbounded succession of
    // later frames. Signal incomplete live delivery before releasing a gap.
    if (
      roots[0]?.state === "uncertain" &&
      (roots.length >= MAX_HELD_ROOT_FRAMES ||
        roots.reduce((count, queued) => count + queued.pending.length, 0) >=
          MAX_HELD_CALLBACKS)
    )
      settle(roots[0], "unknown");
  }
}

/** Run `work` once the transaction this is called in commits. */
export function afterCommit(work: () => void): void {
  const frame = frames.getStore();
  if (frame) frame.pending.push(work);
  else runSafely(work);
}

/**
 * The write has committed by the time this runs, so a failure here must not
 * reach the caller: answered as a failure, a committed write would be
 * retried and written twice.
 */
function runSafely(work: () => void): void {
  try {
    work();
  } catch (err) {
    log("error", "Work after a commit failed", {
      error: errorMessage(err),
    });
  }
}
