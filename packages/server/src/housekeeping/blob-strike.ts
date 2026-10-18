import type { BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { finishCopyDeletion } from "./blob-delete.js";
import { errorMessage } from "../error-text.js";

/**
 * Strike `store`'s copy of `hash` from the location log, with an audit row
 * and an error line, and remove its bytes, so replication can put the copy
 * back from another store. Answers whether a row went: a copy dropped
 * between the finding and the strike is not struck again. The caller holds
 * the blob's upload lock.
 */
export async function strikeCopy(
  storage: Storage,
  store: BlobStore,
  hash: string,
): Promise<boolean> {
  const removed = await runAuditedTransaction(
    storage,
    async () => {
      if (!(await storage.blobs.removeLocation(hash, store.id))) return false;
      await storage.blobs.queueCopyDeletion(hash, store.id);
      return true;
    },
    (removed) =>
      removed
        ? {
            action: "blob.copy_struck",
            resource_type: "blob",
            resource_id: hash,
            client_ip: null,
            details: { store_id: store.id, kind: store.kind },
          }
        : null,
  );
  if (!removed) return false;
  log("error", "blob.copy_struck", {
    hash,
    store_id: store.id,
    kind: store.kind,
  });
  try {
    await finishCopyDeletion(storage, store, hash);
  } catch (err) {
    // The durable cleanup intent survives for the next run.
    log("error", "blob.struck_copy_kept", {
      hash,
      store_id: store.id,
      error: errorMessage(err),
    });
  }
  return true;
}
