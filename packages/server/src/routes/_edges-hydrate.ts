import type { ApiKey, Edge, PaginatedResult } from "@withmarfa/shared";
import type { CursorSortKey, Storage } from "../storage/interface.js";
import {
  ITEM_BACKREFS_CURSOR_KEY,
  ITEM_EDGES_CURSOR_KEY,
  encodeKeyedCursor,
} from "../storage/interface.js";
import { readableEdges } from "./_edge-visibility.js";

/** The most edges of one type an item response carries inline; a block
 *  cut here carries a `next_cursor` for the rest. */
export const HYDRATE_PER_TYPE_CAP = 50;

/** An item's edges keyed by edge type, each block the first page of that
 *  type's edges from the listing its cursor continues at. */
export type HydratedEdges = Record<string, PaginatedResult<Edge>>;

/**
 * The ids of these edges the credential may read, in one query for the
 * whole set however many items it spans.
 */
async function visibleEdgeIds(
  storage: Storage,
  key: ApiKey,
  edges: Edge[],
): Promise<Set<string>> {
  if (edges.length === 0) return new Set();
  return new Set((await readableEdges(storage, key, edges)).map((e) => e.id));
}

/**
 * Drop from every block what the credential may not read, and drop a
 * block that empties.
 *
 * **After the cut rather than before it**, matching `GET /edges`: the cap
 * and the cursor come from the store's own window and are left alone, so
 * a block can come back shorter than the cap while `next_cursor` still says
 * there is more to page for. Filtering first would move the cursor onto
 * the readable rows of one window, and a client would stop on a block
 * that had simply been thinned.
 *
 * **A block that empties is removed, not left standing empty.** The key
 * of a block is an edge type, so an empty block named `about` says this
 * item has `about` edges the caller may not see — the disclosure the
 * filter exists to close, in the shape of a map key. It takes the
 * block's cursor with it: an item whose first fifty edges
 * of a kind are all unreadable carries no block for that kind and no
 * cursor into it, and the readable ones behind them are reached through
 * `GET /items/{id}/edges?edge_type=X`, which pages the whole relation
 * under the same gate. Nothing is unreachable; the inline block simply
 * stops being the way to it.
 */
function applyVisibility(
  blocks: HydratedEdges,
  visible: Set<string>,
): HydratedEdges {
  const out: HydratedEdges = {};
  for (const [type, block] of Object.entries(blocks)) {
    const data = block.data.filter((edge) => visible.has(edge.id));
    if (data.length === 0) continue;
    out[type] = { ...block, data };
  }
  return out;
}

/** An item's outbound edges grouped by type, each block cut at the cap
 *  with a cursor `GET /items/{id}/edges?edge_type=X` continues, and held
 *  to the same two permissions the edge doors ask for. */
export async function hydrateEdgesForItem(
  storage: Storage,
  key: ApiKey,
  itemId: string,
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<HydratedEdges> {
  const batched = await storage.edges.listFromSourcesBatched([itemId], cap + 1);
  const blocks = groupAndCap(
    batched.get(itemId) ?? [],
    cap,
    ITEM_EDGES_CURSOR_KEY,
  );
  const visible = await visibleEdgeIds(
    storage,
    key,
    Object.values(blocks).flatMap((b) => b.data),
  );
  return applyVisibility(blocks, visible);
}

/** The same for every item of a listing, from one query — and one
 *  visibility query for the whole page rather than one per item, which on
 *  a page of five hundred would be five hundred serial round trips. */
export async function hydrateEdgesForItems(
  storage: Storage,
  key: ApiKey,
  itemIds: string[],
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<Map<string, HydratedEdges>> {
  if (itemIds.length === 0) return new Map();
  const batched = await storage.edges.listFromSourcesBatched(itemIds, cap + 1);
  const capped = new Map<string, HydratedEdges>();
  const all: Edge[] = [];
  for (const id of itemIds) {
    const blocks = groupAndCap(
      batched.get(id) ?? [],
      cap,
      ITEM_EDGES_CURSOR_KEY,
    );
    capped.set(id, blocks);
    for (const block of Object.values(blocks)) all.push(...block.data);
  }
  const visible = await visibleEdgeIds(storage, key, all);
  const out = new Map<string, HydratedEdges>();
  for (const [id, blocks] of capped) {
    out.set(id, applyVisibility(blocks, visible));
  }
  return out;
}

/** An item's inbound edges grouped by type, each block cut at the cap
 *  with a cursor `GET /items/{id}/backrefs?edge_type=X` continues.
 *
 *  The direction that needs both questions rather than one: the anchor
 *  here is the **target**, and an edge's readability is its source
 *  item's — a row the caller of this hydration never authorized. */
export async function hydrateBackrefsForItem(
  storage: Storage,
  key: ApiKey,
  itemId: string,
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<HydratedEdges> {
  const batched = await storage.edges.listToTargetsBatched([itemId], cap + 1);
  const blocks = groupAndCap(
    batched.get(itemId) ?? [],
    cap,
    ITEM_BACKREFS_CURSOR_KEY,
  );
  const visible = await visibleEdgeIds(
    storage,
    key,
    Object.values(blocks).flatMap((b) => b.data),
  );
  return applyVisibility(blocks, visible);
}

/**
 * Group edges already in a listing's order by type and cut each block at
 * the cap. A cut block's cursor is the last in-window edge's position,
 * readable or not, under
 * `cursorKey`, the key of the listing the caller will continue at, so it
 * is read there like a cursor that listing minted itself.
 */
export function groupAndCap(
  edges: Edge[],
  cap: number,
  cursorKey: CursorSortKey,
): HydratedEdges {
  const out: HydratedEdges = {};
  for (const edge of edges) {
    const block = out[edge.edge_type] ?? { data: [], next_cursor: null };
    block.data.push(edge);
    out[edge.edge_type] = block;
  }
  for (const type of Object.keys(out)) {
    const block = out[type];
    if (!block) continue;
    if (block.data.length > cap) {
      const last = block.data[cap - 1];
      if (last) {
        block.next_cursor = encodeKeyedCursor(
          last.created_at,
          last.id,
          cursorKey,
        );
      }
      block.data = block.data.slice(0, cap);
    }
  }
  return out;
}
