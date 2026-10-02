/**
 * In-flight tracking + error isolation for fire-and-forget writes.
 *
 * Two writers deliberately run off the critical path: audit rows, emitted
 * via `void storage.audit.log(...)` so an audit failure can never block or
 * break the user-facing flow, and the OAuth grant's `last_used_at` stamp,
 * fired by the bearer middleware after the response. The trade-off is the
 * same for both: the returned promise is never awaited and carries no
 * `.catch()` — so if the underlying write rejects (e.g. the connection pool
 * was torn down while it was still in flight), it surfaces as an unhandled
 * promise rejection, which the server reports as a fault and a test run
 * fails on.
 *
 * This tracker is the owning store's seam for two guarantees that hold the
 * fire-and-forget contract unchanged from the caller's side:
 *
 *   1. `track(write)` runs the insert, swallows any rejection (logging it at
 *      warn level), and never re-throws. A late or failed audit write can
 *      therefore never become an unhandled rejection, in tests or prod.
 *
 *   2. `drain()` resolves once every write started so far has settled. The
 *      storage's `close()` awaits it (bounded by the caller) so pending
 *      audit inserts land — or at least finish failing harmlessly — before
 *      the pool is closed and, in the test harness, before the per-file
 *      database clone is dropped. This removes the window where a write
 *      outruns teardown and hits a destroyed pool.
 *
 * Production semantics are unchanged: callers still don't await, the write
 * still happens off the critical path, and a graceful shutdown simply
 * drains anything in flight instead of force-killing it.
 */
export class WriteTracker {
  private readonly pending = new Set<Promise<void>>();

  /** Names the writer in the warn log so a failure is attributable. */
  constructor(private readonly label: string) {}

  /**
   * Run a fire-and-forget write under tracking. Returns a promise that
   * resolves when the write settles and never rejects — a failed write is
   * logged and otherwise ignored, matching the non-blocking contract.
   * Awaiting the returned promise (which callers generally don't) is
   * therefore always safe.
   */
  track(write: () => Promise<void>): Promise<void> {
    const settled = (async () => {
      try {
        await write();
      } catch (err) {
        // A tracked write must never break or block the flow it observes.
        // One that fails — including one that loses the race against pool
        // teardown — is logged and dropped rather than propagated as an
        // unhandled rejection.
        console.warn(`[${this.label}] write failed (non-blocking)`, err);
      }
    })();
    this.pending.add(settled);
    void settled.finally(() => {
      this.pending.delete(settled);
    });
    return settled;
  }

  /**
   * Resolve once every write started before this call has settled. Writes
   * started after `drain()` begins are not awaited — callers drain as part
   * of shutdown, by which point no new writes should be issued.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
