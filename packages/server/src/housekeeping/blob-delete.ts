import type { BlobStore } from "../storage/blob-store.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { log } from "../middleware/logger.js";
import type { AuditLogEntry, Storage } from "../storage/interface.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { errorMessage } from "../error-text.js";

/**
 * Where bytes leave a store once a row has named them. The copy rules are
 * written over the location log, and every deletion here answers to it: a
 * drop goes only if the log's count of live copies allows it, decided in
 * the one statement that removes the row; a purge takes a blob to zero
 * only because the orphan report named it on an earlier run and nothing
 * names it in the transaction that removes the row; a strike's
 * second half discards bytes the check has just struck from the log. Each
 * runs under the per-hash lock the upload takes, so an upload's own
 * check-and-record cannot interleave with it.
 *
 * Upload, archive restore and replication also call a store's `delete` to
 * take back bytes this request wrote when the row that would have named
 * them was refused, under the same lock and before any row exists.
 */
export interface Stores {
  readonly stores: readonly BlobStore[];
  byId(id: string): BlobStore | undefined;
}

export class CopiesBelowMinimum extends Error {
  constructor(
    readonly hash: string,
    readonly live: number,
    readonly minCopies: number,
  ) {
    super(
      `dropping a copy of ${hash} would leave ${String(live - 1)} live copies, below the minimum of ${String(minCopies)}`,
    );
    this.name = "CopiesBelowMinimum";
  }
}

export class LocationNotFound extends Error {
  constructor(
    readonly hash: string,
    readonly storeId: string,
  ) {
    super(`no attached store ${storeId} holds a copy of ${hash}`);
    this.name = "LocationNotFound";
  }
}

/**
 * Drop one store's copy of a blob, when the log says enough live copies
 * would remain. Location removal, audit and cleanup intent commit together
 * before bytes are deleted, so a store failure leaves a retryable intent
 * and the drop still succeeds.
 */
export async function dropBlobCopy(
  storage: Storage,
  stores: Stores,
  hash: string,
  storeId: string,
  minCopies: number,
  actor: Pick<AuditLogEntry, "key_id" | "client_ip"> = { client_ip: null },
): Promise<void> {
  const store = stores.byId(storeId);
  if (!store) throw new LocationNotFound(hash, storeId);
  await withBlobUploadLock(hash, async () => {
    await runAuditedTransaction(
      storage,
      async () => {
        const outcome = await storage.blobs.dropLocationKeeping(
          hash,
          storeId,
          minCopies,
        );
        if (outcome === "absent") throw new LocationNotFound(hash, storeId);
        if (outcome === "below_minimum") {
          const live = (await storage.blobs.listLocations(hash)).filter(
            (location) => !location.detached,
          ).length;
          throw new CopiesBelowMinimum(hash, live, minCopies);
        }
        await storage.blobs.queueCopyDeletion(hash, storeId);
      },
      {
        ...actor,
        action: "blob.copy_dropped",
        resource_type: "blob",
        resource_id: hash,
        details: { store_id: storeId },
      },
    );
    try {
      await finishCopyDeletion(storage, store, hash);
    } catch (err) {
      // The drop has committed, so it stands; the durable cleanup intent
      // survives for the next run.
      log("error", "blob.dropped_copy_kept", {
        hash,
        store_id: storeId,
        error: errorMessage(err),
      });
    }
  });
}

/**
 * Take a blob the orphan report named to zero, if it is still due. The
 * decision and the row's removal are one transaction (`claimOrphanPurge`),
 * which checks that the report still stands within `due` and that nothing
 * references the blob, so an upload of the same bytes or a write naming
 * them that landed after the sweep's walk keeps it. The bytes go after the
 * row, from every attached store rather than the ones the log names,
 * because a copy the log did not know about would otherwise outlive its
 * row; a purge record covers the gap, so a failure between the two leaves
 * the next sweep a purge to finish (`finishPurge`) rather than a row naming
 * bytes that are gone. Answers whether the blob was purged.
 */
export async function purgeBlob(
  storage: Storage,
  stores: Stores,
  hash: string,
  due: { before: string; runStartedAt: string },
): Promise<boolean> {
  return withBlobUploadLock(hash, async () => {
    const claimed = await runAuditedTransaction(
      storage,
      () => storage.blobs.claimOrphanPurge(hash, due.before, due.runStartedAt),
      (claimed) =>
        claimed
          ? {
              action: "blob.purge",
              resource_type: "blob",
              resource_id: hash,
              client_ip: null,
            }
          : null,
    );
    if (!claimed) return false;
    await deleteEverywhere(storage, stores, hash);
    return true;
  });
}

/**
 * Finish a purge whose row went and whose bytes may not have: delete them
 * from every attached store and clear the record. An upload of the same
 * bytes clears the record in the transaction that registers them, so a
 * record gone by the time the lock is held means the bytes are stored
 * again and stay.
 */
export async function finishPurge(
  storage: Storage,
  stores: Stores,
  hash: string,
): Promise<void> {
  await withBlobUploadLock(hash, async () => {
    if (!(await storage.blobs.purgePending(hash))) return;
    await deleteEverywhere(storage, stores, hash);
  });
}

async function deleteEverywhere(
  storage: Storage,
  stores: Stores,
  hash: string,
): Promise<void> {
  for (const store of stores.stores) {
    await store.delete(hash);
    await storage.blobs.settleCopyDeletion(hash, store.id);
  }
  await storage.blobs.settlePurge(hash);
}

/** Caller holds the per-hash lock, including through any replacement write. */
export async function finishCopyDeletion(
  storage: Storage,
  store: BlobStore,
  hash: string,
): Promise<void> {
  if (!(await storage.blobs.beginCopyDeletionAttempt(hash, store.id))) return;
  await store.delete(hash);
  await storage.blobs.settleCopyDeletion(hash, store.id);
}

/** Retry committed cleanup without creating a second domain mutation or audit. */
export async function finishPendingCopyDeletions(
  storage: Storage,
  stores: Stores,
  limit: number,
): Promise<void> {
  for (const copy of await storage.blobs.listPendingCopyDeletions(limit)) {
    const store = stores.byId(copy.store_id);
    if (!store) continue;
    try {
      await withBlobUploadLock(copy.hash, () =>
        finishCopyDeletion(storage, store, copy.hash),
      );
    } catch (err) {
      log("error", "blob.copy_deletion_unfinished", {
        hash: copy.hash,
        store_id: copy.store_id,
        error: errorMessage(err),
      });
    }
  }
}
