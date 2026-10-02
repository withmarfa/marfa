/**
 * Serializes the upload of one set of bytes against itself.
 *
 * An upload spools and hashes its body before it knows the hash, so the
 * bytes land outside any lock. What follows is three steps that have to
 * agree: `has` on the disk store, the spool's rename into place (or its
 * discard, when the bytes are already there), and the registration of the
 * row and the location.
 *
 * The first step decides something it cannot know on its own. `has` answers
 * "were these bytes here a moment ago", not "are these bytes mine", and
 * content addressing makes the difference matter: deduplicating identical
 * bytes is the design, so two requests uploading the same attachment is
 * ordinary rather than exotic. Both read absent, both rename (the store
 * discards the loser's spool), and if either one's registration is then
 * refused, its undo deletes a file the other has already committed a row
 * against.
 *
 * Holding this lock across all three steps is what makes the `has` answer
 * authoritative: within a hash, no second uploader can interleave, so a
 * request that saw absent really did place the bytes and really is the only
 * one that may take them back.
 *
 * **Keyed on the hash, so it costs nothing to unrelated uploads.** Two
 * requests contend only when they are uploading byte-identical content, in
 * which case the second one's rename was redundant anyway and it skips
 * straight to registering against what the first placed.
 *
 * **In-process, and a mutex rather than a lease.** An upload is a user action
 * that has to complete, so a caller waits its turn rather than being told to
 * go away. In-process is enough because there is one process: SQLite admits
 * one writer, and the server is it.
 *
 * **Not a database transaction.** The step that has to be serialized is a
 * filesystem rename, which no transaction can hold or roll back, and the
 * registration already runs in one of its own.
 */

/**
 * Tail of the queue per hash. Entries are removed once the last waiter
 * drains, so the map tracks in-flight uploads rather than every hash the
 * process has ever seen.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to one content hash. Waiters run in call
 * order, and a rejection from one caller does not strand the next: the queue
 * advances on settlement, not on success.
 */
export async function withBlobUploadLock<T>(
  hash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const predecessor = inFlight.get(hash);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Published before the first await, so two synchronous callers queue in the
  // order they arrived rather than both finding an empty slot.
  inFlight.set(hash, held);
  if (predecessor) await predecessor;
  try {
    return await fn();
  } finally {
    release();
    if (inFlight.get(hash) === held) inFlight.delete(hash);
  }
}

/**
 * Run `fn` holding the lock on every hash in `hashes`, taken one at a time
 * in sorted order so two callers holding several never wait on each other
 * in a cycle. For a request that checks, places and registers several
 * blobs as one step.
 */
export async function withBlobUploadLocks<T>(
  hashes: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const sorted = [...new Set(hashes)].sort();
  const take = (i: number): Promise<T> => {
    const hash = sorted[i];
    return hash === undefined
      ? fn()
      : withBlobUploadLock(hash, () => take(i + 1));
  };
  return take(0);
}
