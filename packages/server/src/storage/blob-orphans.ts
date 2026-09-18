import type { Storage } from "./interface.js";
import type { BlobBackend } from "./blob-backend.js";
import { collectBlobHashes } from "./blob-utils.js";

/**
 * What an unreferenced blob is, defined once.
 *
 * Two callers ask the same question: the operator route, which answers it
 * on demand and defaults to reporting rather than deleting, and the
 * scheduled sweep, which answers it on a timer with a grace window. The
 * expensive half is the reference scan, and getting it wrong deletes bytes
 * something still points at, so it lives here rather than in either
 * caller. Live items, trashed items, metadata extensions and version
 * snapshots all count as references.
 */
export interface BlobSweepResult {
  /** Candidates considered: every registered hash, or only those old
   *  enough when a cutoff was given. */
  totalBlobs: number;
  /** Distinct hashes something points at, across everything scanned. */
  referenced: number;
  /** Candidates nothing points at. */
  orphaned: number;
  /** Actually deleted; zero on a dry run. */
  removed: number;
}

export interface BlobSweepOptions {
  storage: Storage;
  blobBackend: BlobBackend;
  /** Report without deleting. */
  dryRun: boolean;
  /** ISO 8601. Only consider hashes whose every row was registered
   *  before this. Undefined considers all of them, which is right for a
   *  caller who has decided for themselves and wrong for a timer. */
  registeredBefore?: string;
}

/** Page size for both corpus walks. Large enough that a big space is not
 *  a thousand round trips, small enough not to hold a whole page of
 *  properties per iteration. */
const SCAN_PAGE = 200;

export async function sweepUnreferencedBlobs(
  options: BlobSweepOptions,
): Promise<BlobSweepResult> {
  const { storage, blobBackend, dryRun, registeredBefore } = options;

  const candidates =
    registeredBefore === undefined
      ? await storage.blobs.listAll()
      : await storage.blobs.listRegisteredBefore(registeredBefore);

  const referencedHashes = new Set<string>();

  // One pass over every lifecycle state. This walked the corpus twice —
  // once bare and once with the state pinned to `trashed` — because the
  // bare listing applies the default that hides the bin, and there was no
  // way to ask for all four states at once. `all_states` is that way, and
  // it is one filter rather than a second full scan.
  //
  // The union has to include the bin: a blob referenced only by a trashed
  // item is still referenced, and removing it would strip the bytes out
  // from under a restore. The pinned second pass was what held that, so
  // the widening here is load-bearing rather than a tidy-up.
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await storage.items.list({
      all_states: true,
      limit: SCAN_PAGE,
      cursor,
    });
    for (const item of page.data) {
      collectBlobHashes(item.properties, referencedHashes);
    }

    // Also scan metadata extensions for blob references
    const ids = page.data.map((item) => item.id);
    const metadataList = await storage.metadata.getMany(ids);
    for (const meta of metadataList) {
      collectBlobHashes(meta.extensions, referencedHashes);
    }
    cursor = page.cursor ?? undefined;
    hasMore = page.has_more;
  }

  // A hash referenced only by a version snapshot is still referenced:
  // deleting it would strip the bytes out from under a version read.
  let versionCursor: string | undefined;
  for (;;) {
    const page = await storage.versions.scanProperties(
      SCAN_PAGE,
      versionCursor,
    );
    for (const props of page.properties) {
      collectBlobHashes(props, referencedHashes);
    }
    if (!page.cursor) break;
    versionCursor = page.cursor;
  }

  const orphaned = candidates.filter((h) => !referencedHashes.has(h));

  if (!dryRun) {
    for (const hash of orphaned) {
      await blobBackend.delete(hash);
      await storage.blobs.remove(hash);
    }
  }

  return {
    totalBlobs: candidates.length,
    referenced: referencedHashes.size,
    orphaned: orphaned.length,
    removed: dryRun ? 0 : orphaned.length,
  };
}
