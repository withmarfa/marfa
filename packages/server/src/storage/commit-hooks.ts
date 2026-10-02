import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "../middleware/logger.js";

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
}

const frames = new AsyncLocalStorage<Frame>();

export async function withCommitHooks<T>(
  open: (body: () => Promise<T>) => Promise<T>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const parent = frames.getStore();
  const frame: Frame = { pending: [] };
  const result = await open(() => frames.run(frame, async () => await fn()));
  if (parent) parent.pending.push(...frame.pending);
  else for (const run of frame.pending) runSafely(run);
  return result;
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
