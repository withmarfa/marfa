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
 * The caller that has its turn on a hash, and the store calls it stopped
 * waiting for. A store can still carry out a write or a delete after its
 * caller stops waiting, so the turn ends only once every such call has.
 */
interface Turn {
  calls: Set<Promise<unknown>>;
  /** The refusal for a caller that will not wait on those calls. */
  refusal: (() => Error) | undefined;
}

const turns = new Map<string, Turn>();

/** Callers queued on a hash that will not wait on an unanswered call. */
const refusing = new Map<string, Set<(error: Error) => void>>();

export interface LockOptions {
  /**
   * Reject with the holder's refusal, rather than wait, while the hash is
   * held past a store call its holder stopped waiting for. For a request,
   * which should not hang on a store that does not answer.
   */
  refuseUnanswered?: boolean;
}

/**
 * Join the queue for one hash and wait for its turn, answering the release.
 * Published before the first await, so two synchronous callers queue in the
 * order they arrived rather than both finding an empty slot.
 */
async function acquire(
  hash: string,
  options: LockOptions = {},
): Promise<() => void> {
  const refusal = turns.get(hash)?.refusal;
  if (options.refuseUnanswered && refusal) throw refusal();
  const predecessor = inFlight.get(hash);
  let resolve!: () => void;
  const held = new Promise<void>((done) => {
    resolve = done;
  });
  inFlight.set(hash, held);
  const end = (turn?: Turn) => {
    if (turn && turns.get(hash) === turn) turns.delete(hash);
    resolve();
    if (inFlight.get(hash) === held) inFlight.delete(hash);
  };
  if (predecessor && options.refuseUnanswered) {
    let refuse!: (error: Error) => void;
    const refused = new Promise<Error>((done) => {
      refuse = done;
    });
    const waiting = refusing.get(hash) ?? new Set();
    refusing.set(hash, waiting.add(refuse));
    const outcome = await Promise.race([
      predecessor.then(() => undefined),
      refused,
    ]);
    waiting.delete(refuse);
    if (waiting.size === 0 && refusing.get(hash) === waiting)
      refusing.delete(hash);
    if (outcome) {
      // The slot stays in the queue until the turn it waited for ends.
      void predecessor.then(() => {
        end();
      });
      throw outcome;
    }
  } else if (predecessor) {
    await predecessor;
  }
  const turn: Turn = { calls: new Set(), refusal: undefined };
  turns.set(hash, turn);
  return () => {
    if (turn.calls.size === 0) end(turn);
    else
      void Promise.allSettled([...turn.calls]).then(() => {
        end(turn);
      });
  };
}

/**
 * Keep the turn on `hash`, which the caller holds, until `call` settles,
 * even after the caller releases it. For a store write or delete the caller
 * stopped waiting for: the store can still carry it out, so nothing else
 * may change the hash's copies until it has. A caller queued with
 * `refuseUnanswered` is refused with `refusal()` until then.
 */
export function outlastBlobUploadLock(
  hash: string,
  call: Promise<unknown>,
  refusal: () => Error,
): void {
  const turn = turns.get(hash);
  if (!turn) throw new Error(`no caller holds the upload lock on ${hash}`);
  turn.calls.add(call);
  turn.refusal ??= refusal;
  const settled = () => {
    turn.calls.delete(call);
    if (turn.calls.size === 0) turn.refusal = undefined;
  };
  call.then(settled, settled);
  for (const refuse of refusing.get(hash) ?? []) refuse(refusal());
}

/**
 * Run `fn` with exclusive access to one content hash. Waiters run in call
 * order, and a rejection from one caller does not strand the next: the queue
 * advances on settlement, not on success.
 */
export async function withBlobUploadLock<T>(
  hash: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const release = await acquire(hash, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** What {@link tryBlobUploadLock} answers for a hash someone holds. */
export const LOCK_HELD: unique symbol = Symbol("blob upload lock held");

/**
 * Run `fn` with exclusive access to one content hash if no one holds or
 * waits for it, or answer {@link LOCK_HELD} at once. For housekeeping,
 * which leaves a held blob to a later run rather than wait on a store call
 * that may not end soon.
 */
export async function tryBlobUploadLock<T>(
  hash: string,
  fn: () => Promise<T>,
): Promise<T | typeof LOCK_HELD> {
  if (inFlight.has(hash)) return LOCK_HELD;
  return withBlobUploadLock(hash, fn);
}

/**
 * Take the locks on every hash in `hashes` and hold them until the answered
 * function is called, which may be called more than once. For a request that
 * checks, places and registers several blobs as one step.
 *
 * Taken one at a time in sorted order, so two callers holding several never
 * wait on each other in a cycle, and in a loop rather than by nesting, so a
 * request naming thousands of hashes takes them all.
 */
export async function holdBlobUploadLocks(
  hashes: readonly string[],
): Promise<() => void> {
  const releases: (() => void)[] = [];
  for (const hash of [...new Set(hashes)].sort()) {
    releases.push(await acquire(hash));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
  };
}
