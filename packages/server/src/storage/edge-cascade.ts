import { ErrorCode, MarfaError, getEdgeTypeSchema } from "@withmarfa/shared";
import type { Edge } from "@withmarfa/shared";
import type { EdgeStore } from "./interface.js";

/**
 * Plans the cascade consequences of deleting a root item. Walks outbound
 * edges from the root and any cascade-reachable descendants; for each edge,
 * consults the edge-type registry's cascade_on_delete:
 *
 *   - cascade: recursively add the target item to the cascade set
 *     (e.g. parent-of — deleting the parent cascades to children).
 *   - block: reject the delete; accumulate all blockers for a helpful error.
 *   - orphan: no action (FK cascade cleans up the edge row at the DB level).
 *
 * Also checks inbound block edges: an edge from anywhere with
 * cascade_on_delete = block pointing AT the item under delete rejects too.
 *
 * Returns the ordered list of item ids to delete — depth-first, leaves
 * before roots — so callers can soft- or hard-delete them in that order.
 *
 * Run inside the caller's transaction.
 */
export async function planCascadeDelete(
  edgeStore: EdgeStore,
  rootItemId: string,
  tenantId?: string,
): Promise<string[]> {
  const visited = new Set<string>();
  const ordered: string[] = [];
  const blockers: Edge[] = [];
  const MAX_DEPTH = 10000;

  async function walk(itemId: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Cascade-delete depth limit (${String(MAX_DEPTH)}) exceeded — graph may contain a cycle`,
        { item_id: itemId },
      );
    }
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const { outbound, inbound } = await edgeStore.listAllByItem(
      itemId,
      tenantId,
    );

    // Block edges on EITHER side reject the delete outright.
    for (const edge of [...outbound, ...inbound]) {
      const schema = getEdgeTypeSchema(edge.edge_type, tenantId);
      if (schema?.cascade_on_delete === "block") {
        blockers.push(edge);
      }
    }
    if (blockers.length > 0) return; // short-circuit; outer caller will throw.

    // Cascade: walk outbound cascade edges → recurse into targets.
    for (const edge of outbound) {
      const schema = getEdgeTypeSchema(edge.edge_type, tenantId);
      if (schema?.cascade_on_delete === "cascade") {
        await walk(edge.target_id, depth + 1);
      }
    }

    // Post-order: leaves first.
    ordered.push(itemId);
  }

  await walk(rootItemId, 0);

  if (blockers.length > 0) {
    throw new MarfaError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Cannot delete item ${rootItemId}: blocked by ${String(blockers.length)} edge(s) with cascade_on_delete=block`,
      {
        root_item_id: rootItemId,
        blocking_edges: blockers.map((e) => ({
          id: e.id,
          edge_type: e.edge_type,
          source_id: e.source_id,
          target_id: e.target_id,
        })),
      },
    );
  }

  return ordered;
}
