/**
 * Periodic GC of terminal bulk_action_jobs rows. Mirrors the
 * RateLimitWindowCleaner pattern — single-process timer, retention window
 * measured against `finished_at`.
 */
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";

export class BulkActionJobGcSweeper {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private storage: Storage,
    private retentionMs: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.retentionMs <= 0) return;
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Single-tick sweep. Exposed for tests. Returns the number of rows
   *  deleted; 0 means nothing was due. */
  async runOnce(): Promise<number> {
    if (this.retentionMs <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionMs,
    ).toISOString();

    const deleted = await this.storage.bulkActionJobs.gcExpired(cutoff);
    if (deleted > 0) {
      log("info", "bulk_action_jobs_gc.swept", { deleted, cutoff });
    }
    return deleted;
  }
}
