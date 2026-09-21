/**
 * Sweeps terminal `bulk_action_jobs` rows past a retention window measured
 * against `finished_at`. The housekeeping scheduler owns the cadence.
 */
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";

export class BulkActionJobGcSweeper {
  constructor(
    private storage: Storage,
    private retentionMs: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep. Returns the number of rows deleted; 0 means nothing was
   *  due. */
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
