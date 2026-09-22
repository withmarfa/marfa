import { edgePermissionCovers } from "@withmarfa/shared";
import type { ApiKey, Edge } from "@withmarfa/shared";
import { mayReadType } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/**
 * Whether this credential may be told about this edge.
 *
 * The two questions `GET /edges/{id}` asks before it answers, as one
 * reading the plural doors, the item's own doors and the stream all take
 * rather than three copies of the same pair. Reading an edge discloses
 * both endpoints, the kind of relationship and the properties on it, so a
 * credential refused one edge at the single door cannot be handed the
 * same edge inside a page, inside an item's response, or on the stream.
 *
 * The pair is deliberately asymmetric: the edge type is the edge's own,
 * and readability is the **source item's** — an edge is a statement made
 * by its source about its target. A door anchored on the target
 * therefore answers a question about a row it never read, which is what
 * `GET /items/{id}/backrefs` got wrong.
 */
export function edgeKindReadable(key: ApiKey, edge: Edge): boolean {
  return edgePermissionCovers(key.edge_permissions, edge.edge_type, "read");
}

/**
 * The source half, given the type of the source item.
 *
 * `undefined` means the source could not be resolved, and it does not
 * refuse: `GET /edges/{id}` reads a source it cannot find as a source
 * with no type to refuse, and a plural door that decided the other way
 * would disagree with the singular one about the same row — the
 * disagreement this whole reading exists to remove. Only the stream
 * actually reaches it, and `routes/events.ts` says there what that costs.
 */
export function sourceTypeReadable(
  key: ApiKey,
  sourceType: string | undefined,
): boolean {
  return sourceType === undefined || mayReadType(key, sourceType);
}

/**
 * The edges of this set the credential may read, with the source items
 * resolved in one query rather than one per row.
 *
 * Rows are dropped rather than refused, because every caller is answering
 * with a collection: a collection that refused would tell a caller a row
 * it may not read exists. A page or a block can therefore come back
 * shorter than it was asked for, and empty while its `has_more` is true —
 * the pagination signals are the store's and are left alone, so paging
 * still walks the whole listing.
 *
 * Trashed sources are read too, for the reason the single door reads
 * them: a plain `items.get` answers null for a trashed source, and a null
 * source has no type to refuse, so trashing the source item would turn a
 * refusal into a disclosure.
 *
 * The source lookup runs even where the caller has already authorized the
 * anchor it is about to read edges off — `GET /items/{id}/edges`, whose
 * anchor is every row's source. Paid rather than threaded through,
 * because the alternative is a parameter saying "already checked" that a
 * later caller can pass wrongly and nothing would catch; the cost is one
 * keyed read per response, on doors that have already made several.
 */
export async function readableEdges(
  storage: Storage,
  key: ApiKey,
  edges: Edge[],
): Promise<Edge[]> {
  const ofReadableKind = edges.filter((edge) => edgeKindReadable(key, edge));
  if (ofReadableKind.length === 0) return [];
  const sources = await storage.items.getMany(
    [...new Set(ofReadableKind.map((edge) => edge.source_id))],
    { includeTrashed: true },
  );
  return ofReadableKind.filter((edge) =>
    sourceTypeReadable(key, sources.get(edge.source_id)?.type),
  );
}

/**
 * The same pair for a single edge, for a caller holding one rather than a
 * collection: the event stream, which sees one frame at a time.
 *
 * It costs one keyed read of the source item, and only where the edge
 * type passed first — a subscriber that may not read the kind of
 * relationship pays nothing. `readableEdges` answers the empty set
 * without querying at all in that case.
 */
export async function edgeReadable(
  storage: Storage,
  key: ApiKey,
  edge: Edge,
): Promise<boolean> {
  return (await readableEdges(storage, key, [edge])).length === 1;
}
