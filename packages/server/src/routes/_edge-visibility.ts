import { edgePermissionCovers, parseFilter } from "@withmarfa/shared";
import type { ApiKey, Edge } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { mayReadType, requireEdgePermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/**
 * Whether this credential may be told about this edge.
 *
 * The two questions `GET /edges/{id}` asks before it answers, as one
 * reading the plural doors, the item's own doors and the stream all take
 * rather than three copies of the same pair. The stream asks the source
 * half of the type its event carries rather than of a row it reads. Reading an edge discloses
 * both endpoints, the kind of relationship and the properties on it, so a
 * credential refused one edge at the single door cannot be handed the
 * same edge inside a page, inside an item's response, or on the stream.
 *
 * The pair is deliberately asymmetric: the edge type is the edge's own,
 * and readability is the **source item's** — an edge is a statement made
 * by its source about its target. A door anchored on the target, such as
 * `GET /items/{id}/backrefs`, therefore reads the source before answering.
 */
export function edgeKindReadable(key: ApiKey, edge: Edge): boolean {
  return edgePermissionCovers(key.edge_permissions, edge.edge_type, "read");
}

/**
 * The pair for an announced edge, asked of the source type its event
 * carries (`EdgeEvent.sourceType`), live or replayed from the log.
 *
 * The stream cannot ask a row instead: a purge announces the edges it took
 * after their source has gone. An event carrying no type is withheld,
 * because a source that cannot be classified cannot be shown readable.
 */
export function announcedEdgeReadable(
  key: ApiKey,
  edge: Edge,
  sourceType: string | undefined,
): boolean {
  return (
    edgeKindReadable(key, edge) &&
    sourceType !== undefined &&
    mayReadType(key, sourceType)
  );
}

/**
 * The source half, given the type of the source item.
 *
 * `undefined` means the source could not be resolved, and it does not
 * refuse: `GET /edges/{id}` reads a source it cannot find as a source
 * with no type to refuse, and a plural door that decided the other way
 * would disagree with the singular one about the same row — the
 * disagreement this whole reading exists to remove. The branch is
 * unreachable on these doors, because an edge row and the item it hangs
 * off go together: a purge takes both, and a trash leaves the row to be
 * found, which is why they read the trashed ones too.
 *
 * The event stream does not ask this. An edge frame there can outlive its
 * source, so it carries the source's type from when it was published, and
 * a frame carrying none is withheld.
 */
function sourceTypeReadable(
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
 * shorter than it was asked for, and empty with a `next_cursor` still to
 * follow — the cursor is the store's and is left alone, so paging
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
 * Also what every door announcing an edge reads, so the event carries its
 * source's type (`EdgeEvent.sourceType`).
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
 * collection.
 *
 * It costs one keyed read of the source item, and only where the edge
 * type passed first. `readableEdges` answers the empty set without
 * querying at all in that case.
 */
export async function edgeReadable(
  storage: Storage,
  key: ApiKey,
  edge: Edge,
): Promise<boolean> {
  return (await readableEdges(storage, key, [edge])).length === 1;
}

/**
 * Refuse a filter term naming a relationship this credential may not read.
 *
 * The query grammar takes `edge[<type>]` and `backref[<type>]`, on
 * `GET /items` through the shorthand or the full `filter=` form and on
 * `GET /search` through `filter=` alone. A term naming one is a question
 * about a relationship and it is answered: `edge[X]=<id>` returns the
 * items that point at that one, `backref[X]=<id>` the items it points at.
 * So a caller refused an edge type could ask whether an edge of it exists
 * and be told, with itself supplying one end and the page naming the other.
 *
 * **Refused rather than dropped, which is the opposite of what the doors
 * answering with edges do.** Those narrow a page of rows, and a row that
 * is gone is evidence of nothing. This narrows on a term the caller
 * wrote: honoring it answers the question, and dropping it answers a
 * different question under the same status — the unfiltered page the
 * unknown-parameter refusal exists to prevent.
 *
 * An anchor the caller may not read is not refused: the store counts only
 * edges with a readable source, so a hidden `backref` anchor matches as none.
 */
export function assertFilterEdgeTermsReadable(
  c: Context<AppEnv>,
  filter: string | undefined,
): void {
  if (filter === undefined) return;
  for (const condition of parseFilter(filter).conditions) {
    if (condition.field.kind !== "edge") continue;
    requireEdgePermission(c, condition.field.edge_type, "read");
  }
}
