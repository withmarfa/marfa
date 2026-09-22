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
 * disagreement this whole reading exists to remove.
 *
 * **On the collection doors the branch is unreachable**, because an edge
 * row and the item it hangs off go together: a purge takes both, and a
 * trash leaves the row to be found, which is why those doors read the
 * trashed ones too. **On the event stream it is reachable and it
 * discloses**: a purge announces each cascaded `edge.deleted` after the
 * row has gone, so a credential holding the edge type and no read on the
 * purged item's type learns that edge's endpoints and properties.
 * Refusing there instead would withhold those frames from every
 * subscriber, the one that could read the purged item included, because
 * the type nobody can resolve is the same for all of them — so the
 * choice is between disclosing to a few and breaking reconciliation for
 * all. Closing it properly means carrying the source's type on the event
 * where the publisher still knows it, which is a change to the event's
 * shape and to the log, and a decision rather than a fix.
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
  const types = await sourceTypesFor(
    storage,
    ofReadableKind.map((edge) => edge.source_id),
  );
  return ofReadableKind.filter((edge) =>
    sourceTypeReadable(key, types.get(edge.source_id)),
  );
}

/**
 * The types of these source items, deduplicated and read in one query.
 *
 * Trashed sources are read too, for the reason the single door reads
 * them: a plain `items.get` answers null for a trashed source, and a null
 * source has no type to refuse, so trashing the source item would turn a
 * refusal into a disclosure. An id with no row is simply absent from the
 * answer, which `sourceTypeReadable` reads as a source with no type.
 *
 * Separate from `readableEdges` for the one caller that cannot use it:
 * the event stream's replay, which holds a page of stored rows rather
 * than a page of edges and has to decode them before it can ask anything.
 */
export async function sourceTypesFor(
  storage: Storage,
  sourceIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return new Map();
  const sources = await storage.items.getMany(unique, {
    includeTrashed: true,
  });
  return new Map([...sources].map(([id, item]) => [id, item.type]));
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
