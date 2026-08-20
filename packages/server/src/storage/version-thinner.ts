import { getTypeSchema } from "@withmarfa/shared";
import type { CoordinationStore, VersionStore } from "./interface.js";
import {
  computeVersionsToDelete,
  resolvePolicy,
  type ResolvedPolicy,
} from "./version-thinning.js";
import { log } from "../middleware/logger.js";
import { logJobTickFailure } from "./job-tick.js";

const BATCH_SIZE = 100;
const DELETE_CHUNK_SIZE = 200;

export class VersionThinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private versionStore: VersionStore,
    private globalDefaults: ResolvedPolicy,
    private intervalMs: number,
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 5_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** One tick, for schedulers that own the cadence themselves. Keeps the
   *  coordination lock and failure logging the timer path applies. */
  runOnce(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      if (this.coordination) {
        await this.coordination.withJobLock("version-thinning", () =>
          this.doPoll(),
        );
      } else {
        await this.doPoll();
      }
    } catch (err) {
      logJobTickFailure("Version thinning", err, this.stopped);
    }
  }

  private async doPoll(): Promise<void> {
    const candidates = await this.versionStore.listThinningCandidates(
      2,
      BATCH_SIZE,
    );

    let totalDeleted = 0;
    for (const candidate of candidates) {
      const deleted = await this.thinItem(
        candidate.itemId,
        candidate.type,
        candidate.spaceId,
      );
      totalDeleted += deleted;
    }

    if (totalDeleted > 0) {
      log(
        "info",
        `Version thinning: pruned ${String(totalDeleted)} versions across ${String(candidates.length)} items`,
      );
    }
  }

  private async thinItem(
    itemId: string,
    itemType: string,
    spaceId: string | null,
  ): Promise<number> {
    // Resolve the type within its owning space so a custom type's
    // version_policy is honored; core types resolve regardless.
    const typeSchema = getTypeSchema(itemType, spaceId);
    const typePolicy = typeSchema?.version_policy;
    const policy = resolvePolicy(typePolicy, this.globalDefaults);

    const versions = await this.versionStore.list(itemId);
    const idsToDelete = computeVersionsToDelete(versions, policy);

    if (idsToDelete.length === 0) return 0;

    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += DELETE_CHUNK_SIZE) {
      const chunk = idsToDelete.slice(i, i + DELETE_CHUNK_SIZE);
      deleted += await this.versionStore.deleteByIds(chunk);
    }
    return deleted;
  }
}
