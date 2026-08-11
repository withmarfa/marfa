import type { Storage } from "./interface.js";

/** What every blob reader needs back: enough to serve or pack the bytes. */
export interface ResolvedBlob {
  mime_type: string;
  size: number;
  storage_path: string;
}

/**
 * Resolve a blob's metadata for a reader working in `spaceId`, or across
 * every space when the reader is not confined to one.
 *
 * The `blobs` table is keyed `(space_id, hash)`, with `""` standing for the
 * instance-wide bucket a single-space self-host writes into. A reader with no
 * space is either a platform admin, whose reach is every space, or that
 * self-host, whose only rows are the `""` ones. Looking `""` up in the first
 * case reports absence for bytes that are plainly there, and **absence is the
 * dangerous direction**: absence is what a repair, a purge, or an archive
 * manifest acts on. An export took that path and recorded `blob_count: 0` for
 * an instance full of files.
 *
 * Content addressing is what makes the widened lookup well defined: every row
 * for a hash describes the same bytes, so which space's row answers does not
 * change the answer.
 *
 * One implementation because this rule was re-derived per route and diverged:
 * three read routes were corrected once and a fourth call site kept the old
 * shape, with nothing to notice.
 */
export function resolveBlobForSpace(
  storage: Storage,
  spaceId: string | undefined,
  hash: string,
): Promise<ResolvedBlob | null> {
  return spaceId === undefined
    ? storage.blobs.getAcrossSpaces(hash)
    : storage.blobs.get(hash, spaceId);
}
