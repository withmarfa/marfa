import {
  ErrorCode,
  getTypeSchema,
  MarfaError,
  type VersionPolicy,
} from "@withmarfa/shared";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import type { Storage } from "./interface.js";
import { resolveTypeSchema } from "./policy.js";
import {
  computeVersionsToDelete,
  resolvePolicy,
  type ResolvedPolicy,
} from "./version-thinning.js";
import { log } from "../middleware/logger.js";

const PAGE_SIZE = 100;
const DELETE_CHUNK_SIZE = 200;

type Decision =
  | { kind: "keep" }
  | { kind: "unresolvable"; type: string }
  | { kind: "delete"; ids: string[] };

interface Step {
  deleted: number;
  versionIds: string[];
  /** No more to remove from this item: the policy keeps what is left. */
  done: boolean;
  /** The item's type, when its inheritance chain could not be resolved. */
  unresolvable?: string;
}

/**
 * Prunes item version history to each type's effective policy: the one
 * `GET /types/{id}` returns, with the instance defaults filling the fields no
 * type in the chain sets. One `runOnce()` sweeps every item holding more than
 * two snapshots, a page at a time; the background job scheduler owns the cadence.
 */
export class VersionThinner {
  constructor(
    private storage: Storage,
    private globalDefaults: ResolvedPolicy,
  ) {}

  /** One sweep. Reports how many versions were pruned across how many
   *  items it looked at. */
  async runOnce(): Promise<{ pruned: number; items: number }> {
    const unresolvable = new Set<string>();
    let pruned = 0;
    let items = 0;
    let after: string | undefined;

    for (;;) {
      const page = await this.storage.versions.listThinningCandidates(
        2,
        PAGE_SIZE,
        after,
      );
      for (const candidate of page) {
        items++;
        if (unresolvable.has(candidate.type)) continue;
        pruned += await this.thinItem(candidate.itemId, unresolvable);
      }
      const last = page.at(-1);
      if (page.length < PAGE_SIZE || !last) break;
      after = last.itemId;
      await yieldBulkWork();
    }

    if (pruned > 0) {
      log(
        "info",
        `Version thinning: pruned ${String(pruned)} versions across ${String(items)} items`,
      );
    }
    return { pruned, items };
  }

  /** A read outside any transaction decides whether a write is worth opening.
   *  Each transaction then reads the item's type and snapshots again, so a
   *  type replaced or an item retyped while the sweep runs is judged as it
   *  now stands, and removes one bounded chunk. An item wrongly passed over
   *  by the first read keeps its history until the next run. */
  private async thinItem(
    itemId: string,
    unresolvable: Set<string>,
  ): Promise<number> {
    const note = (type: string): void => {
      if (unresolvable.has(type)) return;
      unresolvable.add(type);
      log(
        "warn",
        `Version thinning skipped the items of type "${type}": its inheritance chain cannot be resolved`,
        { type_id: type },
      );
    };

    const first = await this.decide(itemId);
    if (first.kind === "unresolvable") note(first.type);
    if (first.kind !== "delete") return 0;

    let deleted = 0;
    for (;;) {
      const step = await runAuditedTransaction(
        this.storage,
        () => this.thinStep(itemId),
        (result) =>
          result.deleted > 0
            ? {
                action: "item.versions_thinned",
                resource_type: "item",
                resource_id: itemId,
                client_ip: null,
                details: {
                  pruned: result.deleted,
                  version_ids: result.versionIds,
                },
              }
            : null,
      );
      if (step.unresolvable !== undefined) {
        note(step.unresolvable);
        return deleted;
      }
      deleted += step.deleted;
      if (step.done) return deleted;
      await yieldBulkWork();
    }
  }

  private async decide(itemId: string): Promise<Decision> {
    const item = await this.storage.items.getIncludingTrashed(itemId);
    if (!item) return { kind: "keep" };

    let typePolicy: VersionPolicy | undefined;
    try {
      typePolicy = resolveTypeSchema(item.type, (id) =>
        getTypeSchema(id),
      )?.version_policy;
    } catch (error) {
      if (
        error instanceof MarfaError &&
        error.code === ErrorCode.TYPE_CHAIN_UNRESOLVABLE
      ) {
        return { kind: "unresolvable", type: item.type };
      }
      throw error;
    }
    const policy = resolvePolicy(typePolicy, this.globalDefaults);

    const versions = await this.storage.versions.all(itemId);
    const ids = computeVersionsToDelete(versions, policy);
    return ids.length > 0 ? { kind: "delete", ids } : { kind: "keep" };
  }

  private async thinStep(itemId: string): Promise<Step> {
    const none: Step = { deleted: 0, versionIds: [], done: true };
    const decision = await this.decide(itemId);
    if (decision.kind === "unresolvable") {
      return { ...none, unresolvable: decision.type };
    }
    if (decision.kind !== "delete") return none;

    const chunk = decision.ids.slice(0, DELETE_CHUNK_SIZE);
    const deleted = await this.storage.versions.deleteByIds(chunk);
    return {
      deleted,
      versionIds: chunk,
      done: deleted === 0 || decision.ids.length <= chunk.length,
    };
  }
}
