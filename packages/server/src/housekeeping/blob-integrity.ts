import { BlobStoreUnreachable } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import { LOCK_HELD, tryBlobUploadLock } from "../storage/blob-upload-lock.js";
import { finishPendingCopyDeletions, type Stores } from "./blob-delete.js";
import { copyIntact, strikeCopy } from "./blob-strike.js";
import { storeCheckTimeoutMs, within } from "../storage/blob-layer.js";
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
  /** Attached stores the run could not reach, whose copies it left alone. */
  unreachable: number;
};

/**
 * Every copy the copy record claims is checked on a schedule, least recently
 * checked first across every attached store, so a store with many copies
 * cannot keep the run from ever reaching another. A disk copy is
 * re-hashed, which reads every byte; an object store is asked for the
 * object by name and size, since its bytes were verified before they left
 * and a fetch to re-hash them would cost the transfer the direct link
 * exists to avoid. A copy found present and intact is stamped; one found
 * missing or altered is struck from the copy record with an error line and an
 * audit row, and the caller wakes replication to put it back from another
 * store.
 *
 * A store that cannot be reached, such as a disk folder that went away, a
 * drive that did not mount or a store that does not answer within the
 * store check bound, says nothing of its copies: none is stamped or struck,
 * the store is named in the result and the log, and the rest of the run
 * goes to the other stores. The question to a store that does not answer
 * is called off. A store's `delete`, which finishes a queued copy deletion
 * or removes a struck copy's bytes, is waited on for the same bound, and
 * one that goes unanswered counts its store unreachable; a struck copy
 * stays struck, with its deletion queued. A copy whose blob's upload lock
 * is held, such as by a delete a store has not finished, is skipped and
 * stays first in line.
 */
export class BlobIntegrityChecker {
  constructor(
    private readonly storage: Storage,
    private readonly stores: Stores,
    private readonly bounds: IntegrityBounds,
    private readonly nowFn: () => Date = () => clock.now(),
  ) {}

  async runOnce(): Promise<IntegrityResult> {
    const unreachable = await finishPendingCopyDeletions(
      this.storage,
      this.stores,
      this.bounds.maxRows,
    );
    let verified = 0;
    let struck = 0;
    let bytes = 0;
    const attached = this.stores.stores.map((store) => store.id);
    const asked = new Set<string>();
    // Listed again once a store turns out to be unreachable: its copies are
    // never stamped, so they would stay first in line and fill every run's
    // rows ahead of the stores that can answer.
    for (let relist = true; relist && asked.size < this.bounds.maxRows;) {
      relist = false;
      const rows = await this.storage.blobs.listToVerify(
        attached.filter((id) => !unreachable.has(id)),
        this.bounds.maxRows,
      );
      for (const row of rows) {
        const key = `${row.store_id} ${row.hash}`;
        const store = this.stores.byId(row.store_id);
        if (!store || asked.has(key) || unreachable.has(row.store_id)) continue;
        if (asked.size >= this.bounds.maxRows) break;
        // A copy that would cross the byte bound still goes when it is the
        // run's first, so one larger than the bound is checked, not skipped
        // forever.
        if (
          verified + struck > 0 &&
          bytes + row.size_bytes > this.bounds.maxBytes
        ) {
          return { verified, struck, bytes, unreachable: unreachable.size };
        }
        asked.add(key);
        const reached = await tryBlobUploadLock(row.hash, async () => {
          let intact: boolean;
          try {
            intact =
              store.kind === "disk"
                ? await copyIntact(store, row.hash, row.size_bytes)
                : (
                    await within(
                      (cancel) => store.has(row.hash, cancel),
                      storeCheckTimeoutMs(),
                    )
                  )?.size_bytes === row.size_bytes;
          } catch (err) {
            // A store that cannot answer is not evidence against the copy: it
            // is neither stamped nor struck, and the rest of the run goes on.
            if (err instanceof BlobStoreUnreachable) {
              unreachable.add(store.id);
              // Not a copy the run checked, so it takes no row of its bound.
              asked.delete(key);
              log("error", "blob.store_unreachable", {
                store_id: store.id,
                kind: store.kind,
                error: errorMessage(err),
              });
              return false;
            }
            log("error", "blob.integrity_unchecked", {
              hash: row.hash,
              store_id: store.id,
              error: errorMessage(err),
            });
            return true;
          }
          bytes += row.size_bytes;
          if (intact) {
            await this.storage.blobs.markVerified(
              row.hash,
              store.id,
              this.nowFn().toISOString(),
            );
            verified += 1;
            return true;
          }
          // A row dropped by an operator between the listing and the check is
          // not a strike: nothing was found wrong with a copy the copy record claims.
          try {
            if (await strikeCopy(this.storage, store, row.hash)) struck += 1;
          } catch (err) {
            if (!(err instanceof BlobStoreUnreachable)) throw err;
            // Struck, with its deletion queued; the store that did not
            // finish the deletion is asked nothing more this run.
            struck += 1;
            unreachable.add(store.id);
            log("error", "blob.store_unreachable", {
              store_id: store.id,
              kind: store.kind,
              error: errorMessage(err),
            });
            return false;
          }
          return true;
        });
        if (reached === LOCK_HELD) {
          // Not checked, so it takes no row of the run's bound.
          asked.delete(key);
          continue;
        }
        if (!reached) {
          relist = true;
          break;
        }
      }
    }
    return { verified, struck, bytes, unreachable: unreachable.size };
  }
}
