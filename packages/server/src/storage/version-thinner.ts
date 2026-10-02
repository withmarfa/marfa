import { getTypeSchema } from "@withmarfa/shared";
import type { VersionStore } from "./interface.js";
import {
  computeVersionsToDelete,
  resolvePolicy,
  type ResolvedPolicy,
} from "./version-thinning.js";
import { log } from "../middleware/logger.js";

const BATCH_SIZE = 100;
const DELETE_CHUNK_SIZE = 200;

/**
 * Prunes item version history to each type's policy. One `runOnce()` takes
 * a batch of the items with the most versions and thins them; the
 * housekeeping scheduler owns the cadence.
 */
export class VersionThinner {
  constructor(
    private versionStore: VersionStore,
    private globalDefaults: ResolvedPolicy,
  ) {}

  /** One batch. Reports how many versions were pruned across how many
   *  items. */
  async runOnce(): Promise<{ pruned: number; items: number }> {
    const candidates = await this.versionStore.listThinningCandidates(
      2,
      BATCH_SIZE,
    );

    let pruned = 0;
    for (const candidate of candidates) {
      pruned += await this.thinItem(candidate.itemId, candidate.type);
    }

    if (pruned > 0) {
      log(
        "info",
        `Version thinning: pruned ${String(pruned)} versions across ${String(candidates.length)} items`,
      );
    }
    return { pruned, items: candidates.length };
  }

  private async thinItem(itemId: string, itemType: string): Promise<number> {
    // Resolve the type so a custom type's version_policy is honored.
    const typeSchema = getTypeSchema(itemType);
    const typePolicy = typeSchema?.version_policy;
    const policy = resolvePolicy(typePolicy, this.globalDefaults);

    const versions = await this.versionStore.all(itemId);
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
