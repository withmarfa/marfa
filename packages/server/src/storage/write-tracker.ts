import { reportableError } from "../error-text.js";

/**
 * Tracks asynchronous operational writes such as the OAuth last-used stamp.
 * Rejections are logged and drained before storage closes. Domain mutations
 * and their audit records never use this tracker: they are awaited together.
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
        console.warn(
          `[${this.label}] write failed (non-blocking)`,
          reportableError(err),
        );
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
