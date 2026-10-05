import type { BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import {
  finishCopyDeletion,
  finishPendingCopyDeletions,
} from "./blob-delete.js";
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
// signature, so it cannot satisfy the `BackgroundJobReport` the scheduler
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
    await finishPendingCopyDeletions(
      this.storage,
      this.stores,
      this.bounds.maxBlobs,
    );
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
        // Under the per-hash lock a purge takes, and only while the row
        // stands: a copy put after a purge removed the row and the bytes
        // would be bytes in a store that nothing names and nothing sweeps.
        const placed = await withBlobUploadLock(blob.hash, () =>
          this.copy(blob.hash, target),
        );
        if (!placed) continue;
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

  /** Copy one blob into `target` and record it, if it is still registered
   *  and a source still has it. Answers whether the copy landed. */
  private async copy(hash: string, target: BlobStore): Promise<boolean> {
    if (!(await this.storage.blobs.get(hash))) return false;
    await finishCopyDeletion(this.storage, target, hash);
    const present = (await target.has(hash)) !== null;
    const source = await this.sourceFor(hash, target.id);
    if (!source) return false;
    const read = await source.get(hash);
    if (!read) {
      // The log names a copy the store no longer has. The integrity
      // check is what strikes it; the next run finds another source.
      return false;
    }
    try {
      await target.put(hash, {
        stream: read.stream,
        size_bytes: read.size_bytes,
      });
    } catch (err) {
      read.stream.destroy();
      log("error", "blob.replicate_failed", {
        hash,
        from: source.id,
        to: target.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    try {
      await runAuditedTransaction(
        this.storage,
        () => this.storage.blobs.recordLocation(hash, target.id),
        {
          action: "blob.copy_replicated",
          resource_type: "blob",
          resource_id: hash,
          client_ip: null,
          details: { from: source.id, store_id: target.id },
        },
      );
    } catch (err) {
      if (!present) {
        try {
          // A committed or uncertain location keeps its bytes.
          if (
            !(await this.storage.blobs.listLocations(hash)).some(
              (location) => location.store_id === target.id,
            )
          )
            await target.delete(hash);
        } catch (cleanupErr) {
          log("error", "blob.orphaned_after_refused_replication", {
            hash,
            store_id: target.id,
            error: String(cleanupErr),
          });
        }
      }
      throw err;
    }
    return true;
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
