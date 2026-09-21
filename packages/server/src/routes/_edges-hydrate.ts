import type { Edge } from "@withmarfa/shared";
import type { CursorSortKey, Storage } from "../storage/interface.js";
import {
  ITEM_BACKREFS_CURSOR_KEY,
  ITEM_EDGES_CURSOR_KEY,
  encodeKeyedCursor,
} from "../storage/interface.js";

/** The most edges of one type an item response carries inline; a block
 *  cut here says so with `has_more` and a cursor for the rest. */
export const HYDRATE_PER_TYPE_CAP = 50;

export interface HydratedEdgeBlock {
  edges: Edge[];
  has_more: boolean;
  next_cursor?: string;
}

export type HydratedEdges = Record<string, HydratedEdgeBlock>;

/** An item's outbound edges grouped by type, each block cut at the cap
 *  with a cursor `GET /items/{id}/edges?edge_type=X` continues. */
export async function hydrateEdgesForItem(
  storage: Storage,
  itemId: string,
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<HydratedEdges> {
  const batched = await storage.edges.listFromSourcesBatched([itemId], cap + 1);
  const edges = batched.get(itemId) ?? [];
  return groupAndCap(edges, cap, ITEM_EDGES_CURSOR_KEY);
}

/** The same for every item of a listing, from one query. */
export async function hydrateEdgesForItems(
  storage: Storage,
  itemIds: string[],
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<Map<string, HydratedEdges>> {
  if (itemIds.length === 0) return new Map();
  const batched = await storage.edges.listFromSourcesBatched(itemIds, cap + 1);
  const out = new Map<string, HydratedEdges>();
  for (const id of itemIds) {
    const edges = batched.get(id) ?? [];
    out.set(id, groupAndCap(edges, cap, ITEM_EDGES_CURSOR_KEY));
  }
  return out;
}

/** An item's inbound edges grouped by type, each block cut at the cap
 *  with a cursor `GET /items/{id}/backrefs?edge_type=X` continues. */
export async function hydrateBackrefsForItem(
  storage: Storage,
  itemId: string,
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<HydratedEdges> {
  const batched = await storage.edges.listToTargetsBatched([itemId], cap + 1);
  const edges = batched.get(itemId) ?? [];
  return groupAndCap(edges, cap, ITEM_BACKREFS_CURSOR_KEY);
}

/**
 * Group edges already in a listing's order by type and cut each block at
 * the cap. A cut block's cursor is the last visible edge's position under
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
    const block = out[edge.edge_type] ?? { edges: [], has_more: false };
    block.edges.push(edge);
    out[edge.edge_type] = block;
  }
  for (const type of Object.keys(out)) {
    const block = out[type];
    if (!block) continue;
    if (block.edges.length > cap) {
      block.has_more = true;
      const last = block.edges[cap - 1];
      if (last) {
        block.next_cursor = encodeKeyedCursor(
          last.created_at,
          last.id,
          cursorKey,
        );
      }
      block.edges = block.edges.slice(0, cap);
    }
  }
  return out;
}
