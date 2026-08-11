import type { PgClient } from "./connection.js";

type Reserved = Awaited<ReturnType<PgClient["reserve"]>>;

/**
 * Reserve a connection from `client`, giving up after `timeoutMs`.
 *
 * postgres.js queues `reserve()` callers with no bound, so a pool whose
 * slots are all held turns every new reservation into an indefinite wait —
 * and two of this codebase's reservation sites sit where waiting forever is
 * the failure: a background tick that should skip instead, and a stream
 * request that should answer 503 instead. Returns `null` on timeout. If
 * the abandoned reservation is eventually granted, it releases itself, so
 * a timed-out caller never leaks the slot it gave up waiting for.
 */
export async function reserveWithTimeout(
  client: PgClient,
  timeoutMs: number,
): Promise<Reserved | null> {
  const reservation = client.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });
  try {
    const winner = await Promise.race([reservation, timeout]);
    if (winner !== null) return winner;
    reservation
      .then((late) => {
        late.release();
      })
      .catch(() => {
        // The pool closed before the queued reservation was granted;
        // nothing to release.
      });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
