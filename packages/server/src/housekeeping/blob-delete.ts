import { BlobStoreUnreachable, type BlobStore } from "../storage/blob-store.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { log } from "../middleware/logger.js";
import type {
  AuditLogEntry,
  BlobLocation,
  Storage,
} from "../storage/interface.js";
import {
  LOCK_HELD,
  tryBlobUploadLock,
  withBlobUploadLock,
} from "../storage/blob-upload-lock.js";
import { errorMessage } from "../error-text.js";
import {
  awaitStoreChange,
  storeCheckTimeoutMs,
  within,
} from "../storage/blob-layer.js";

/**
 * Where bytes leave a store once a row has named them. The copy rules are
 * written over the location log, and every deletion here answers to it: a
 * drop goes only if the log's count of live copies allows it, decided in
 * the one statement that removes the row, and the stores confirm enough of
 * the copies that remain; a purge takes a blob to zero only because the
 * orphan report named it on an earlier run and nothing names it in the
 * transaction that removes the row; a strike's second half discards bytes
 * the check has just struck from the log. Each
 * runs under the per-hash lock the upload takes, so an upload's own
 * check-and-record cannot interleave with it.
 *
 * Upload, archive restore and replication also call a store's `delete` to
 * take back bytes this request wrote when the row that would have named
 * them was refused, under the same lock and before any row exists.
 *
 * A store's `delete` here is waited on for the store check bound and no
 * longer, and the lock is kept until it ends (`awaitStoreChange`).
 * Housekeeping takes a blob's lock only when it is free, so a later run
 * skips a blob whose delete is still out rather than waiting on it, and a
 * request that takes the lock meanwhile is refused.
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
 * would remain and their stores confirm they hold them. The log alone can
 * name a copy that is gone, such as one a store's late delete removed, and
 * a drop trusting it could take the last real copy. The log is asked first,
 * so a drop it refuses answers without waiting on any store. Location
 * removal, audit and cleanup intent commit together before bytes are
 * deleted, so a store failure leaves a retryable intent and the drop still
 * succeeds.
 *
 * Refused with `blob_store_unavailable`, as every taker of the lock is,
 * while a store has not finished a write or delete of the blob that its
 * caller stopped waiting for: that call can still change the blob's copies.
 */
export async function dropBlobCopy(
  storage: Storage,
  stores: Stores,
  hash: string,
  storeId: string,
  minCopies: number,
  actor: Pick<AuditLogEntry, "key_id" | "client_ip"> = { client_ip: null },
): Promise<void> {
  await withBlobUploadLock(hash, async () => {
    const store = stores.byId(storeId);
    if (!store) throw new LocationNotFound(hash, storeId);
    const live = (await storage.blobs.listLocations(hash)).filter(
      (location) => !location.detached,
    );
    if (!live.some((location) => location.store_id === storeId))
      throw new LocationNotFound(hash, storeId);
    if (live.length - 1 < minCopies)
      throw new CopiesBelowMinimum(hash, live.length, minCopies);
    const confirmed = await confirmedOthers(
      storage,
      stores,
      hash,
      live.filter((location) => location.store_id !== storeId),
    );
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
        // The log allowed it; the stores must too. Thrown here, the row's
        // removal rolls back with the rest of the transaction.
        if (confirmed < minCopies) {
          throw new CopiesBelowMinimum(hash, confirmed + 1, minCopies);
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
 * How many of `others`, the blob's other live copies the log names, their
 * stores confirm they hold at the blob's size, each asked within the store
 * check bound. A store that fails or does not answer confirms nothing. The
 * caller holds the blob's upload lock, so the log's copies of the blob do
 * not change before the drop commits.
 */
async function confirmedOthers(
  storage: Storage,
  stores: Stores,
  hash: string,
  others: readonly BlobLocation[],
): Promise<number> {
  const record = await storage.blobs.get(hash);
  if (!record) return 0;
  const answers = await Promise.all(
    others.map(async (location) => {
      const other = stores.byId(location.store_id);
      if (!other) return false;
      try {
        const held = await within(
          (cancel) => other.has(hash, cancel),
          storeCheckTimeoutMs(),
        );
        return held?.size_bytes === record.size_bytes;
      } catch (err) {
        log("error", "blob.drop_copy_unconfirmed", {
          hash,
          store_id: other.id,
          error: errorMessage(err),
        });
        return false;
      }
    }),
  );
  return answers.filter(Boolean).length;
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
 * bytes that are gone. Answers whether the blob was purged; a blob whose
 * lock is held is left for a later sweep.
 */
export async function purgeBlob(
  storage: Storage,
  stores: Stores,
  hash: string,
  due: { before: string; runStartedAt: string },
): Promise<boolean> {
  const purged = await tryBlobUploadLock(hash, async () => {
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
  return purged === true;
}

/**
 * Finish a purge whose row went and whose bytes may not have: delete them
 * from every attached store and clear the record. An upload of the same
 * bytes clears the record in the transaction that registers them, so a
 * record gone by the time the lock is held means the bytes are stored
 * again and stay. A blob whose lock is held is left for a later sweep.
 */
export async function finishPurge(
  storage: Storage,
  stores: Stores,
  hash: string,
): Promise<void> {
  await tryBlobUploadLock(hash, async () => {
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
    await awaitStoreChange(
      store,
      hash,
      () => store.delete(hash),
      storeCheckTimeoutMs(),
    );
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
  await awaitStoreChange(
    store,
    hash,
    () => store.delete(hash),
    storeCheckTimeoutMs(),
  );
  await storage.blobs.settleCopyDeletion(hash, store.id);
}

/**
 * Retry committed cleanup without creating a second domain mutation or
 * audit. A blob whose lock is held is skipped, and so is every deletion in
 * a store once one there went unanswered. Answers the ids of the stores
 * that did not answer.
 */
export async function finishPendingCopyDeletions(
  storage: Storage,
  stores: Stores,
  limit: number,
): Promise<Set<string>> {
  const unanswered = new Set<string>();
  for (const copy of await storage.blobs.listPendingCopyDeletions(limit)) {
    const store = stores.byId(copy.store_id);
    if (!store || unanswered.has(store.id)) continue;
    try {
      const done = await tryBlobUploadLock(copy.hash, () =>
        finishCopyDeletion(storage, store, copy.hash),
      );
      if (done === LOCK_HELD) continue;
    } catch (err) {
      if (err instanceof BlobStoreUnreachable) unanswered.add(store.id);
      log("error", "blob.copy_deletion_unfinished", {
        hash: copy.hash,
        store_id: copy.store_id,
        error: errorMessage(err),
      });
    }
  }
  return unanswered;
}
