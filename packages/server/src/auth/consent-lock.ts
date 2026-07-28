/**
 * Serializes writes to a user's standing OAuth grant for one client.
 *
 * Four flows write the same (client, user) grant: the interactive
 * consent decision, the silent re-authorization on `GET /auth/authorize`,
 * the device-flow consent approval, and grant revocation. The silent one
 * is why this exists. It reads the standing grant, lets the OAuth
 * Provider plugin narrow the stored scopes to whatever the client asked
 * for this time, then writes the standing set back. That read and that
 * write straddle an entire proxy round trip, so without serialization a
 * narrowing or a revocation committed in between is overwritten by a
 * restoration computed before it happened, and a permission the user
 * just took away comes back.
 *
 * Every flow that writes the record takes the lock, not just the one
 * with the widest window: a writer outside it can still land inside
 * another's read-modify-write and leave a state no ordering of the two
 * user actions would produce.
 *
 * A mutex, not a lease: a caller waits its turn rather than being told to
 * go away, because every one of these flows is a user action that has to
 * complete. Contention is per (client, user) and each critical section is
 * a single consent operation, so waiting is bounded by the operation in
 * front.
 *
 * **In-process.** One server process is fully covered, which is the whole
 * of a SQLite deployment by construction. Across processes the remaining
 * fence is the checked write in `setConsentScopes`, which refuses to
 * restore unless the row still holds exactly what the plugin just put
 * there. That narrows the multi-process window without closing it: a
 * competing write landing before the plugin's own rewrite is erased by
 * that rewrite, and the restoration then finds what it expected. Closing
 * it outright needs a shared lock held for the length of the critical
 * section; `CoordinationStore` offers a try-lock for background jobs,
 * whose "someone else has it, skip this tick" semantics do not fit a
 * user-facing request that has to complete.
 */

/**
 * Tail of the queue per (client, user). Entries are removed once the last
 * waiter drains, so the map tracks in-flight work rather than every pair
 * the process has ever seen.
 */
const inFlight = new Map<string, Promise<void>>();

/** Both parts are percent-encoded, so no pair of ids can collide. */
function lockKey(clientId: string, authUserId: string): string {
  return `${encodeURIComponent(clientId)}:${encodeURIComponent(authUserId)}`;
}

/**
 * How many callers are holding or queued on each key.
 *
 * This exists for the tests that pin an interleaving. To show that a
 * competing request really overlapped the one holding the lock, a test
 * has to observe it arrive; the alternative is to pause for a while and
 * assume it did. That assumption is invisible when it breaks, because a
 * request arriving after the holder has already finished leaves exactly
 * the same end state as one that arrived in time — the test keeps
 * passing and quietly stops covering the race.
 */
const depth = new Map<string, number>();

/**
 * Callers holding or queued on the (client, user) lock right now.
 *
 * Read this to observe arrival, never to decide anything: the count is
 * only true at the instant it is read, so branching on it would race the
 * very thing the lock exists to serialize.
 */
export function consentLockDepth(clientId: string, authUserId: string): number {
  return depth.get(lockKey(clientId, authUserId)) ?? 0;
}

/**
 * Run `fn` with exclusive access to the (client, user) grant. Waiters run
 * in call order, and a rejection from one caller does not strand the
 * next: the queue advances on settlement, not on success.
 */
export async function withConsentLock<T>(
  clientId: string,
  authUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(clientId, authUserId);
  const predecessor = inFlight.get(key);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Both published before the first await, so two synchronous callers
  // queue in the order they arrived rather than both seeing an empty
  // slot, and so a caller counts as arrived from the moment it starts
  // waiting rather than once it gets its turn.
  inFlight.set(key, held);
  depth.set(key, (depth.get(key) ?? 0) + 1);
  if (predecessor) await predecessor;
  try {
    return await fn();
  } finally {
    release();
    if (inFlight.get(key) === held) inFlight.delete(key);
    const remaining = (depth.get(key) ?? 1) - 1;
    if (remaining > 0) depth.set(key, remaining);
    else depth.delete(key);
  }
}
