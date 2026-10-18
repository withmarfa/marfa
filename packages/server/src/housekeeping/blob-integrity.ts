import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { finishPendingCopyDeletions, type Stores } from "./blob-delete.js";
import { copyIntact, strikeCopy } from "./blob-strike.js";
import { errorMessage } from "../error-text.js";
import * as clock from "../clock.js";

export interface IntegrityBounds {
  /** Most copies one run checks, over every store. */
  maxRows: number;
  /** Most bytes one run reads or asks about, over every store. */
  maxBytes: number;
}

// A type alias rather than an interface: an interface carries no index
// signature, so it cannot satisfy the `HousekeepingReport` the scheduler
// takes from a job's run.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type IntegrityResult = {
  verified: number;
  struck: number;
  bytes: number;
};

/**
 * Every copy the log claims is checked on a schedule, least recently
 * checked first across every attached store, so a store with many copies
 * cannot keep the run from ever reaching another. A disk copy is
 * re-hashed, which reads every byte; an object store is asked for the
 * object by name and size, since its bytes were verified before they left
 * and a fetch to re-hash them would cost the transfer the direct link
 * exists to avoid. A copy found present and intact is stamped; one found
 * missing or altered is struck from the log with an error line and an
 * audit row, and the caller wakes replication to put it back from another
 * store.
 */
export class BlobIntegrityChecker {
  constructor(
    private readonly storage: Storage,
    private readonly stores: Stores,
    private readonly bounds: IntegrityBounds,
    private readonly nowFn: () => Date = () => clock.now(),
  ) {}

  async runOnce(): Promise<IntegrityResult> {
    await finishPendingCopyDeletions(
      this.storage,
      this.stores,
      this.bounds.maxRows,
    );
    let verified = 0;
    let struck = 0;
    let bytes = 0;
    const attached = this.stores.stores.map((store) => store.id);
    const rows = await this.storage.blobs.listToVerify(
      attached,
      this.bounds.maxRows,
    );
    for (const row of rows) {
      const store = this.stores.byId(row.store_id);
      if (!store) continue;
      // A copy that would cross the byte bound still goes when it is the
      // run's first, so one larger than the bound is checked, not skipped
      // forever.
      if (
        verified + struck > 0 &&
        bytes + row.size_bytes > this.bounds.maxBytes
      ) {
        break;
      }
      await withBlobUploadLock(row.hash, async () => {
        let intact: boolean;
        try {
          intact =
            store.kind === "disk"
              ? await copyIntact(store, row.hash, row.size_bytes)
              : (await store.has(row.hash))?.size_bytes === row.size_bytes;
        } catch (err) {
          // A store that cannot answer is not evidence against the copy: it
          // is neither stamped nor struck, and the rest of the run goes on.
          log("error", "blob.integrity_unchecked", {
            hash: row.hash,
            store_id: store.id,
            error: errorMessage(err),
          });
          return;
        }
        bytes += row.size_bytes;
        if (intact) {
          await this.storage.blobs.markVerified(
            row.hash,
            store.id,
            this.nowFn().toISOString(),
          );
          verified += 1;
          return;
        }
        // A row dropped by an operator between the listing and the check is
        // not a strike: nothing was found wrong with a copy the log claims.
        if (await strikeCopy(this.storage, store, row.hash)) struck += 1;
      });
    }
    return { verified, struck, bytes };
  }
}
