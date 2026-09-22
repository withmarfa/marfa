import type { BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import type { Stores } from "./blob-delete.js";

export interface ReplicationBounds {
  /** Most blobs one run copies. */
  maxBlobs: number;
  /** Most bytes one run copies. A blob that would cross the bound still
   *  goes when it is the run's first, so a blob larger than the bound is
   *  copied rather than stuck. */
  maxBytes: number;
}

// A type alias rather than an interface: an interface carries no index
// signature, so it cannot satisfy the `HousekeepingReport` the scheduler
// takes from a job's run.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ReplicationResult = {
  copied: number;
  bytes: number;
  /** Copies some attached store still lacks after this run. The caller
   *  wakes the sweep again while this is above zero. */
  remaining: number;
};

/**
 * The policy made true: every attached store gets a copy of every blob some
 * other attached store holds. The column that would say which store wants
 * less is not consulted, because `all` is the one policy this build
 * defines and every row carries it. One sweep in both directions, disk to
 * bucket on an ordinary instance and bucket to disk after a restore,
 * because the log does not care which kind holds a copy. A location is
 * recorded only after the target's `put` has verified that the bytes hash
 * to their name.
 */
export class BlobReplicator {
  constructor(
    private readonly storage: Storage,
    private readonly stores: Stores,
    private readonly bounds: ReplicationBounds,
  ) {}

  async runOnce(): Promise<ReplicationResult> {
    let copied = 0;
    let bytes = 0;
    for (const target of this.stores.stores) {
      if (copied >= this.bounds.maxBlobs || bytes >= this.bounds.maxBytes) {
        break;
      }
      const missing = await this.storage.blobs.listMissingFrom(
        target.id,
        this.bounds.maxBlobs - copied,
      );
      for (const blob of missing) {
        if (copied > 0 && bytes + blob.size_bytes > this.bounds.maxBytes) {
          break;
        }
        const source = await this.sourceFor(blob.hash, target.id);
        if (!source) continue;
        const read = await source.get(blob.hash);
        if (!read) {
          // The log names a copy the store no longer has. The integrity
          // check is what strikes it; the next run finds another source.
          continue;
        }
        try {
          await target.put(blob.hash, {
            stream: read.stream,
            size_bytes: read.size_bytes,
          });
        } catch (err) {
          read.stream.destroy();
          log("error", "blob.replicate_failed", {
            hash: blob.hash,
            from: source.id,
            to: target.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        await this.storage.blobs.recordLocation(blob.hash, target.id);
        copied += 1;
        bytes += blob.size_bytes;
        if (copied >= this.bounds.maxBlobs) break;
      }
    }
    let remaining = 0;
    for (const target of this.stores.stores) {
      remaining += await this.storage.blobs.countMissingFrom(target.id);
    }
    if (copied > 0) {
      log("info", "Blobs replicated", { copied, bytes, remaining });
    }
    return { copied, bytes, remaining };
  }

  /** An attached store the log says holds the blob, other than the target:
   *  the disk first, because reading it costs no transfer. */
  private async sourceFor(
    hash: string,
    targetId: string,
  ): Promise<BlobStore | null> {
    const locations = await this.storage.blobs.listLocations(hash);
    const candidates = locations
      .filter((location) => !location.detached)
      .filter((location) => location.store_id !== targetId)
      .map((location) => this.stores.byId(location.store_id))
      .filter((store): store is BlobStore => store !== undefined);
    return (
      candidates.find((store) => store.kind === "disk") ?? candidates[0] ?? null
    );
  }
}
