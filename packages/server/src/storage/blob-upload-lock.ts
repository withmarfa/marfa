/**
 * Serializes the upload of one set of bytes against itself.
 *
 * A blob upload does three things that have to agree: it asks the backend
 * whether these bytes are already there, it writes them if they are not, and
 * it registers a row. The middle step is deliberately outside the reserving
 * transaction — SQLite admits a single writer, so a transaction held across a
 * multi-megabyte write stalls every other writer in the process for as long as
 * the bytes take to land.
 *
 * That leaves the first step deciding something it cannot know on its own.
 * `exists()` is read before the write with nothing joining the two, so it
 * answers "were these bytes here a moment ago", not "are these bytes mine".
 * Content addressing makes the difference matter: deduplicating identical
 * bytes across spaces is the design, so two requests uploading the same
 * attachment is ordinary rather than exotic. Both read false, both write, and
 * if either is then refused — a quota ceiling is the designed failure on this
 * path — it deletes a blob the other has already committed a row against.
 *
 * Holding this lock across all three steps is what makes the `exists()` answer
 * authoritative: within a hash, no second uploader can interleave, so a
 * request that saw false really did write the bytes and really is the only
 * one that may take them back.
 *
 * **Keyed on the hash, so it costs nothing to unrelated uploads.** Two
 * requests contend only when they are uploading byte-identical content, in
 * which case the second one's write was redundant anyway and it skips
 * straight to registering against what the first wrote.
 *
 * **In-process, and a mutex rather than a lease.** An upload is a user action
 * that has to complete, so a caller waits its turn rather than being told to
 * go away. One WEB process is the documented precondition here: uploads are
 * HTTP, so the process-role split changes nothing, but a deployment scaling
 * to several web copies must first give this lock a cross-process backend —
 * exactly the move `withConsentLock` already made
 * (`storage/pg/consent-lock-backend.ts`), and the template to copy when
 * that day comes. Deployments today hold the precondition by policy (one
 * web container), and a SQLite deployment is covered by construction.
 *
 * A `CoordinationStore` lock is still the wrong tool here, for a concrete
 * reason rather than a stylistic one. `withExclusiveLock` holds one
 * connection of a single-connection pool for the length of its callback,
 * and this callback spans a multi-megabyte write to the blob backend. One
 * upload would therefore serialize every other lock-taker in the process
 * for as long as its bytes take to land, and uploads of unrelated content
 * would serialize against each other for no benefit at all: keying on the
 * hash is what makes this lock free to unrelated uploads, and a shared
 * pool of one throws that away.
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
