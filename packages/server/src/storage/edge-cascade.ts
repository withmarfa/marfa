import { ErrorCode, MarfaError, getEdgeTypeSchema } from "@withmarfa/shared";
import type { Edge } from "@withmarfa/shared";
import type { Storage } from "./interface.js";

/** What trashing a root takes, as `planCascadeDelete` plans it. */
export interface CascadePlan {
  /** The root and every row it takes, leaves first. */
  ordered: string[];
  /** The rows taken as parts whose hosts are all in the bin or going, and
   *  not reached by a `cascade` edge: each goes with its hosts. */
  withHosts: Set<string>;
}

/**
 * Plans what trashing a root item takes: one closure over two rules, run
 * until nothing new joins.
 *
 *   - cascade: the target of an outbound `cascade` edge from a row in the
 *     set (e.g. parent-of: deleting the parent cascades to children).
 *   - with-hosts: the source of a `with-hosts` edge into a row in the set,
 *     once every target of its `with-hosts` edges is in the set or already
 *     in the bin. A part already in the bin is left where it is.
 *
 * A `block` edge on either side of any row in the set refuses the whole
 * plan, naming every blocker. `orphan` does nothing here: `edges` carries no
 * foreign key to `items`, so the caller that removes an item removes its
 * edges (`deleteBySource` / `deleteByTarget`).
 *
 * Every row is judged whatever the caller may read: a caller names in its
 * answer only what it may read.
 *
 * Run inside the caller's transaction.
 */
export async function planCascadeDelete(
  storage: Pick<Storage, "edges" | "items">,
  rootItemId: string,
): Promise<CascadePlan> {
  const inSet = new Set<string>();
  const cascadeReached = new Set<string>();
  const blockers = new Map<string, Edge>();
  /** Each row's children in the plan: its cascade targets and its parts. */
  const children = new Map<string, string[]>();
  const candidates = new Map<string, string[]>();

  const queue = [rootItemId];
  const drain = async (): Promise<void> => {
    for (
      let itemId = queue.shift();
      itemId !== undefined;
      itemId = queue.shift()
    ) {
      if (inSet.has(itemId)) continue;
      inSet.add(itemId);
      const { outbound, inbound } = await storage.edges.listAllByItem(itemId);
      for (const edge of [...outbound, ...inbound]) {
        if (getEdgeTypeSchema(edge.edge_type)?.cascade_on_delete === "block") {
          blockers.set(edge.id, edge);
        }
      }
      const mine = children.get(itemId) ?? [];
      children.set(itemId, mine);
      for (const edge of outbound) {
        if (getEdgeTypeSchema(edge.edge_type)?.cascade_on_delete !== "cascade")
          continue;
        cascadeReached.add(edge.target_id);
        mine.push(edge.target_id);
        queue.push(edge.target_id);
      }
      for (const edge of inbound) {
        if (
          getEdgeTypeSchema(edge.edge_type)?.cascade_on_delete !== "with-hosts"
        )
          continue;
        const hosts = candidates.get(edge.source_id) ?? [];
        hosts.push(itemId);
        candidates.set(edge.source_id, hosts);
      }
    }
  };

  await drain();
  for (;;) {
    const pending = [...candidates.keys()].filter((id) => !inSet.has(id));
    if (pending.length === 0) break;
    const rows = await storage.items.getMany(pending, { includeTrashed: true });
    const joining: string[] = [];
    for (const partId of pending) {
      const part = rows.get(partId);
      if (!part || part.state === "trashed") {
        candidates.delete(partId);
        continue;
      }
      const hosts = (await storage.edges.listAllByItem(partId)).outbound
        .filter(
          (edge) =>
            getEdgeTypeSchema(edge.edge_type)?.cascade_on_delete ===
            "with-hosts",
        )
        .map((edge) => edge.target_id);
      const outside = hosts.filter((id) => !inSet.has(id));
      const held = await storage.items.getMany(outside, {
        includeTrashed: true,
      });
      if (outside.every((id) => held.get(id)?.state === "trashed")) {
        joining.push(partId);
      }
      // A part not joining now may join once more of its hosts are in.
    }
    if (joining.length === 0) break;
    for (const partId of joining) {
      for (const host of candidates.get(partId) ?? []) {
        if (inSet.has(host)) children.get(host)?.push(partId);
      }
      candidates.delete(partId);
      queue.push(partId);
    }
    await drain();
  }

  if (blockers.size > 0) {
    throw new MarfaError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Cannot delete item ${rootItemId}: blocked by ${String(blockers.size)} edge(s) with cascade_on_delete=block`,
      {
        root_item_id: rootItemId,
        blocking_edges: [...blockers.values()].map((e) => ({
          id: e.id,
          edge_type: e.edge_type,
          source_id: e.source_id,
          target_id: e.target_id,
        })),
      },
    );
  }

  // Post-order over the plan, iteratively so a deep chain cannot overflow
  // the stack: leaves first, the root last.
  const ordered: string[] = [];
  const placed = new Set<string>();
  const stack: { id: string; next: number }[] = [{ id: rootItemId, next: 0 }];
  placed.add(rootItemId);
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as { id: string; next: number };
    const kids = children.get(top.id) ?? [];
    const kid = kids[top.next];
    if (kid !== undefined) {
      top.next += 1;
      if (!placed.has(kid) && inSet.has(kid)) {
        placed.add(kid);
        stack.push({ id: kid, next: 0 });
      }
      continue;
    }
    ordered.push(top.id);
    stack.pop();
  }

  const withHosts = new Set(
    [...inSet].filter((id) => id !== rootItemId && !cascadeReached.has(id)),
  );
  return { ordered, withHosts };
}
