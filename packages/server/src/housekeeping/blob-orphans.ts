import type { Storage } from "../storage/interface.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { log } from "../middleware/logger.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { finishPurge, purgeBlob, type Stores } from "./blob-delete.js";

// A type alias rather than an interface: an interface carries no index
// signature, so it cannot satisfy the `HousekeepingReport` the scheduler
// takes from a job's run.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type OrphanResult = {
  /** Blobs nothing references that the report holds after this run. */
  reported: number;
  /** Blobs an earlier run reported longer ago than the grace, now gone. */
  purged: number;
};

/** Page size for the corpus walks. Large enough that a big corpus is not a
 *  thousand round trips, small enough not to hold a whole page of
 *  properties per iteration. */
const SCAN_PAGE = 200;

/**
 * A report before a deletion. Each run computes the blobs nothing
 * references (an item in any lifecycle state, a metadata extension, an
 * edge's properties, a version snapshot and a nonterminal property-update
 * job's patch all count), records each with
 * the time it was first reported, forgets any that is referenced again, and
 * purges only what an earlier run reported longer ago than the grace. Two
 * runs, never one, stand between an unreferenced blob and its deletion, and
 * the report is readable between them. An upload of the same bytes lifts
 * the report, and the purge decides again in its own transaction, so bytes
 * sent or named again while a run is under way are never the ones it
 * deletes.
 */
export class BlobOrphanReporter {
  constructor(
    private readonly storage: Storage,
    private readonly stores: Stores,
    private readonly graceMs: number,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<OrphanResult> {
    const now = this.nowFn();
    const startedAt = now.toISOString();
    // A purge a failing store keeps from finishing stays recorded for the
    // next run and is logged, so it never stops the report being written.
    for (const hash of await this.storage.blobs.listPendingPurges()) {
      try {
        await finishPurge(this.storage, this.stores, hash);
      } catch (err) {
        log("error", "blob.purge_unfinished", {
          hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const unreferenced = await this.unreferencedHashes();
    // The time is read inside the transaction, so a report is never older
    // than an upload that committed before it: the grace always counts
    // from after the last time the bytes were sent.
    await this.storage.runInTransaction(() =>
      this.storage.blobs.retainOrphans(
        unreferenced,
        this.nowFn().toISOString(),
      ),
    );
    // Strictly before both bounds: a report exactly the grace old waits for
    // the next run, and a grace of zero means the next run and never this
    // one.
    const before = new Date(now.getTime() - this.graceMs).toISOString();
    const due = await this.storage.blobs.listOrphansToPurge(before, startedAt);
    let purged = 0;
    // One blob's failure, a busy database or a failing store, is logged
    // and left for the next run rather than ending this one.
    for (const hash of due) {
      try {
        if (
          await purgeBlob(this.storage, this.stores, hash, {
            before,
            runStartedAt: startedAt,
          })
        ) {
          purged += 1;
        }
      } catch (err) {
        log("error", "blob.purge_failed", {
          hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const reported = (await this.storage.blobs.listOrphans()).length;
    if (purged > 0) {
      log("info", "Unreferenced blobs purged", { purged, reported });
    }
    return { reported, purged };
  }

  /**
   * Every registered hash nothing points at. Every lifecycle state, because
   * a reference is a reference whatever state the row naming it sits in: a
   * blob pointed at only by a row in the bin or the archive is still
   * pointed at, and deleting its bytes would strip them out from under the
   * restore the bin exists for. A hash referenced only by a version
   * snapshot is still referenced too, for the same reason.
   *
   * The walk gives the event loop a turn before each page and never inside
   * one, because the driver runs each statement synchronously and a corpus
   * read in one go stops every request until it ends.
   */
  private async unreferencedHashes(): Promise<string[]> {
    const candidates = await this.storage.blobs.listAll();
    const referenced = new Set<string>();
    let cursor: string | undefined;
    do {
      await yieldBulkWork();
      const page = await this.storage.items.list({
        all_states: true,
        limit: SCAN_PAGE,
        cursor,
      });
      for (const item of page.data) {
        collectBlobHashes(item.properties, referenced);
      }
      const metadataList = await this.storage.metadata.getMany(
        page.data.map((item) => item.id),
      );
      for (const meta of metadataList) {
        collectBlobHashes(meta.extensions, referenced);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    let edgeCursor: string | undefined;
    do {
      await yieldBulkWork();
      const page = await this.storage.edges.list({
        limit: SCAN_PAGE,
        cursor: edgeCursor,
      });
      for (const edge of page.data) {
        collectBlobHashes(edge.properties, referenced);
      }
      edgeCursor = page.next_cursor ?? undefined;
    } while (edgeCursor !== undefined);
    let versionCursor: string | undefined;
    for (;;) {
      await yieldBulkWork();
      const page = await this.storage.versions.scanProperties(
        SCAN_PAGE,
        versionCursor,
      );
      for (const props of page.properties) {
        collectBlobHashes(props, referenced);
      }
      if (!page.cursor) break;
      versionCursor = page.cursor;
    }
    let jobCursor: string | undefined;
    for (;;) {
      await yieldBulkWork();
      const page = await this.storage.bulkActionJobs.scanPendingPropertyPatches(
        SCAN_PAGE,
        jobCursor,
      );
      for (const patch of page.patches) collectBlobHashes(patch, referenced);
      if (!page.cursor) break;
      jobCursor = page.cursor;
    }
    return candidates.filter((hash) => !referenced.has(hash));
  }
}
