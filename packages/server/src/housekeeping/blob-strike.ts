import { createHash } from "node:crypto";
import { addAbortSignal } from "node:stream";
import { BlobStoreUnreachable, type BlobStore } from "../storage/blob-store.js";
import { storeCheckTimeoutMs, within } from "../storage/blob-layer.js";
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
 *
 * A store that does not finish the deletion in time throws
 * {@link BlobStoreUnreachable} after the strike has committed, so the
 * caller can stop asking that store; the deletion stays queued. Any other
 * failure to delete is logged, and the deletion stays queued too.
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
    if (err instanceof BlobStoreUnreachable) throw err;
  }
  return true;
}

/**
 * Whether `store`'s copy of `hash` holds the blob, read in full and hashed.
 * `false` when the store holds no copy, holds one of another size, or gives
 * exactly `sizeBytes` bytes that hash to another name. A read that fails,
 * ends short, does not open within the store check bound or is called off
 * by `signal` throws instead, because it says nothing of the copy.
 */
export async function copyIntact(
  store: BlobStore,
  hash: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const read = await within(
    (cancel) => store.get(hash, undefined, cancel),
    storeCheckTimeoutMs(),
    { signal, late: (gone) => gone?.stream.destroy() },
  );
  if (!read) return false;
  if (read.size_bytes !== sizeBytes) {
    read.stream.destroy();
    return false;
  }
  if (signal) addAbortSignal(signal, read.stream);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of read.stream) {
    digest.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  if (bytes !== sizeBytes) {
    throw new Error(
      `The read of ${hash} ended after ${String(bytes)} of ${String(sizeBytes)} bytes`,
    );
  }
  return `sha256:${digest.digest("hex")}` === hash;
}
