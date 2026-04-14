import { getTypeSchema } from "@mymehq/shared";
import type { VersionStore } from "./interface.js";
import {
  computeVersionsToDelete,
  resolvePolicy,
  type ResolvedPolicy,
} from "./version-thinning.js";
import { log } from "../middleware/logger.js";

const BATCH_SIZE = 100;
const DELETE_CHUNK_SIZE = 200;

export class VersionThinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private versionStore: VersionStore,
    private globalDefaults: ResolvedPolicy,
    private intervalMs: number,
  ) {}

  start(): void {
    this.startupTimeout = setTimeout(() => void this.poll(), 5_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const candidates = await this.versionStore.listThinningCandidates(
        2,
        BATCH_SIZE,
      );

      let totalDeleted = 0;
      for (const candidate of candidates) {
        const deleted = await this.thinItem(candidate.itemId, candidate.type);
        totalDeleted += deleted;
      }

      if (totalDeleted > 0) {
        log(
          "info",
          `Version thinning: pruned ${String(totalDeleted)} versions across ${String(candidates.length)} items`,
        );
      }
    } catch (err) {
      log("error", "Version thinning error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async thinItem(itemId: string, itemType: string): Promise<number> {
    const typeSchema = getTypeSchema(itemType);
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
