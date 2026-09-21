import type { Storage } from "../storage/interface.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { log } from "../middleware/logger.js";
import { purgeBlob, type Stores } from "./blob-delete.js";

export interface OrphanResult {
  /** Blobs nothing references that the report holds after this run. */
  reported: number;
  /** Blobs an earlier run reported longer ago than the grace, now gone. */
  purged: number;
}

/** Page size for both corpus walks. Large enough that a big corpus is not a
 *  thousand round trips, small enough not to hold a whole page of
 *  properties per iteration. */
const SCAN_PAGE = 200;

/**
 * A report before a deletion. Each run computes the blobs nothing
 * references (an item in any lifecycle state, a metadata extension and a
 * version snapshot all count), records each with the time it was first
 * reported, forgets any that is referenced again, and purges only what an
 * earlier run reported longer ago than the grace. Two runs, never one,
 * stand between an unreferenced blob and its deletion, and the report is
 * readable between them.
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
    const unreferenced = await this.unreferencedHashes();
    const reported = await this.storage.blobs.retainOrphans(
      unreferenced,
      startedAt,
    );
    // Strictly before both bounds: a report exactly the grace old waits for
    // the next run, and a grace of zero means the next run and never this
    // one.
    const before = new Date(now.getTime() - this.graceMs).toISOString();
    const due = await this.storage.blobs.listOrphansToPurge(before, startedAt);
    let purged = 0;
    for (const hash of due) {
      await purgeBlob(this.storage, this.stores, hash);
      purged += 1;
    }
    if (purged > 0) {
      log("info", "Unreferenced blobs purged", {
        purged,
        reported: reported - purged,
      });
    }
    return { reported: reported - purged, purged };
  }

  /**
   * Every registered hash nothing points at. Every lifecycle state, because
   * a reference is a reference whatever state the row naming it sits in: a
   * blob pointed at only by a row in the bin or the archive is still
   * pointed at, and deleting its bytes would strip them out from under the
   * restore the bin exists for. A hash referenced only by a version
   * snapshot is still referenced too, for the same reason.
   */
  private async unreferencedHashes(): Promise<string[]> {
    const candidates = await this.storage.blobs.listAll();
    const referenced = new Set<string>();
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
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
      cursor = page.cursor ?? undefined;
      hasMore = page.has_more;
    }
    let versionCursor: string | undefined;
    for (;;) {
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
    return candidates.filter((hash) => !referenced.has(hash));
  }
}
