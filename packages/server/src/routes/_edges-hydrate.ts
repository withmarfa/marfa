import type { Edge } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";

/**
 * Default per-edge-type cap for hydrated edges on item responses. Clients
 * fetch more via GET /items/:id/edges?edge_type=X&cursor=...
 */
export const HYDRATE_PER_TYPE_CAP = 50;

export interface HydratedEdgeBlock {
  edges: Edge[];
  has_more: boolean;
  next_cursor?: string;
}

export type HydratedEdges = Record<string, HydratedEdgeBlock>;

/**
 * Hydrate outbound edges for a single item — always invoked on single-item
 * GETs. Groups edges by edge_type; each type's block reports has_more when
 * we hit the cap so callers know to paginate further.
 */
export async function hydrateEdgesForItem(
  storage: Storage,
  itemId: string,
  cap = HYDRATE_PER_TYPE_CAP,
): Promise<HydratedEdges> {
  // Fetch cap+1 per type would need per-type queries; simpler: fetch via the
  // batched path with a single item, then group by type.
  const batched = await storage.edges.listFromSourcesBatched([itemId], cap + 1);
  const edges = batched.get(itemId) ?? [];
  return groupAndCap(edges, cap);
}

/**
 * Hydrate outbound edges for a batch of items (list-read path). Uses the
 * batched store method so one SQL call covers the whole list. Result keyed
 * by item_id.
 */
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
    out.set(id, groupAndCap(edges, cap));
  }
  return out;
}

function groupAndCap(edges: Edge[], cap: number): HydratedEdges {
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
      // Cursor = last-visible edge's (created_at, id) — matches the
      // edge-store listByKey cursor shape so /items/:id/edges?cursor=
      // continues correctly.
      const last = block.edges[cap - 1];
      if (last) {
        block.next_cursor = Buffer.from(
          JSON.stringify({ v: last.created_at, id: last.id }),
        ).toString("base64url");
      }
      block.edges = block.edges.slice(0, cap);
    }
  }
  return out;
}
