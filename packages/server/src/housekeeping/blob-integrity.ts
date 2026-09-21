import { createHash } from "node:crypto";
import type { BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import { discardStruckCopy, type Stores } from "./blob-delete.js";

export interface IntegrityBounds {
  /** Most copies one run checks, over every store. */
  maxRows: number;
  /** Most bytes one run reads or asks about, over every store. */
  maxBytes: number;
}

export interface IntegrityResult {
  verified: number;
  struck: number;
  bytes: number;
}

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
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<IntegrityResult> {
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
      const intact =
        store.kind === "disk"
          ? await this.hashMatches(store, row.hash, row.size_bytes)
          : (await store.has(row.hash))?.size_bytes === row.size_bytes;
      bytes += row.size_bytes;
      if (intact) {
        await this.storage.blobs.markVerified(
          row.hash,
          store.id,
          this.nowFn().toISOString(),
        );
        verified += 1;
        continue;
      }
      // A row dropped by an operator between the listing and the check is
      // not a strike: nothing was found wrong with a copy the log claims.
      if (!(await this.storage.blobs.removeLocation(row.hash, store.id))) {
        continue;
      }
      struck += 1;
      log("error", "blob.copy_struck", {
        hash: row.hash,
        store_id: store.id,
        kind: store.kind,
      });
      try {
        await discardStruckCopy(store, row.hash);
      } catch (err) {
        // The row is gone either way; bytes that cannot be removed are
        // logged, and the next check finds them again.
        log("error", "blob.struck_copy_kept", {
          hash: row.hash,
          store_id: store.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await this.storage.audit.log({
        action: "blob.copy_struck",
        resource_type: "blob",
        resource_id: row.hash,
        client_ip: null,
        details: { store_id: store.id, kind: store.kind },
      });
    }
    return { verified, struck, bytes };
  }

  private async hashMatches(
    store: BlobStore,
    hash: string,
    sizeBytes: number,
  ): Promise<boolean> {
    const read = await store.get(hash);
    if (!read) return false;
    if (read.size_bytes !== sizeBytes) {
      read.stream.destroy();
      return false;
    }
    const digest = createHash("sha256");
    for await (const chunk of read.stream) {
      digest.update(chunk as Buffer);
    }
    return `sha256:${digest.digest("hex")}` === hash;
  }
}
