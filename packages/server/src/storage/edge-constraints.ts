import {
  ErrorCode,
  MymeError,
  getEdgeTypeSchema,
  satisfiesEdgeConstraint,
} from "@mymehq/shared";
import type { Edge, EdgeTypeSchema } from "@mymehq/shared";
import type { EdgeStore, ItemStore } from "./interface.js";

/**
 * Enforces edge-creation invariants:
 *
 * 1. Edge type exists (core or custom registry).
 * 2. Source and target items exist and belong to the same tenant.
 * 3. Source type satisfies source_type_constraints (inheritance-aware).
 * 4. Target type satisfies target_type_constraints (inheritance-aware).
 * 5. Cardinality holds per edge type.
 * 6. Exact duplicate (source, target, edge_type) rejected.
 * 7. Cycles rejected for parent-of and supersedes.
 *
 * Throws MymeError with EDGE_CONSTRAINT_VIOLATION, EDGE_TYPE_NOT_FOUND,
 * EDGE_CYCLE, or ITEM_NOT_FOUND. Run inside the caller's transaction so a
 * failed check rolls back the whole write.
 */
export async function assertEdgeCanBeCreated(
  edgeStore: EdgeStore,
  itemStore: ItemStore,
  input: {
    source_id: string;
    target_id: string;
    edge_type: string;
    tenant_id?: string;
  },
): Promise<EdgeTypeSchema> {
  const schema = getEdgeTypeSchema(input.edge_type);
  if (!schema) {
    throw new MymeError(
      ErrorCode.EDGE_TYPE_NOT_FOUND,
      `Unknown edge type: ${input.edge_type}`,
    );
  }

  if (input.source_id === input.target_id) {
    throw new MymeError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Edge source and target must be different items`,
      { edge_type: input.edge_type },
    );
  }

  const [source, target] = await Promise.all([
    itemStore.get(input.source_id, input.tenant_id),
    itemStore.get(input.target_id, input.tenant_id),
  ]);
  if (!source) {
    throw new MymeError(
      ErrorCode.ITEM_NOT_FOUND,
      `Edge source item not found: ${input.source_id}`,
    );
  }
  if (!target) {
    throw new MymeError(
      ErrorCode.ITEM_NOT_FOUND,
      `Edge target item not found: ${input.target_id}`,
    );
  }

  if (!satisfiesEdgeConstraint(source.type, schema.source_type_constraints)) {
    throw new MymeError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Edge "${input.edge_type}" does not allow source type "${source.type}"`,
      {
        edge_type: input.edge_type,
        source_type: source.type,
        allowed: schema.source_type_constraints,
      },
    );
  }

  if (!satisfiesEdgeConstraint(target.type, schema.target_type_constraints)) {
    throw new MymeError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Edge "${input.edge_type}" does not allow target type "${target.type}"`,
      {
        edge_type: input.edge_type,
        target_type: target.type,
        allowed: schema.target_type_constraints,
      },
    );
  }

  // Exact-duplicate guard — same source/target/type pair.
  const duplicate = await edgeStore.existsExact(
    input.source_id,
    input.target_id,
    input.edge_type,
  );
  if (duplicate) {
    throw new MymeError(
      ErrorCode.EDGE_CONSTRAINT_VIOLATION,
      `Edge "${input.edge_type}" already exists between these items`,
      {
        edge_type: input.edge_type,
        source_id: input.source_id,
        target_id: input.target_id,
      },
    );
  }

  // Cardinality — direction-correct per plan §Critical.
  switch (schema.cardinality) {
    case "one-to-one": {
      // No other edge of this type from this source OR to this target.
      const [sourceCount, targetCount] = await Promise.all([
        edgeStore.countBySource(input.source_id, input.edge_type),
        edgeStore.countByTarget(input.target_id, input.edge_type),
      ]);
      if (sourceCount > 0) {
        throw new MymeError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Edge "${input.edge_type}" is one-to-one; source already has one outbound edge of this type`,
          { edge_type: input.edge_type, source_id: input.source_id },
        );
      }
      if (targetCount > 0) {
        throw new MymeError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Edge "${input.edge_type}" is one-to-one; target already has one inbound edge of this type`,
          { edge_type: input.edge_type, target_id: input.target_id },
        );
      }
      break;
    }
    case "one-to-many": {
      // Each target has at most one inbound edge (e.g. parent-of: one parent per child).
      const targetCount = await edgeStore.countByTarget(
        input.target_id,
        input.edge_type,
      );
      if (targetCount > 0) {
        throw new MymeError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Edge "${input.edge_type}" is one-to-many on the target side; target already has an inbound edge of this type`,
          { edge_type: input.edge_type, target_id: input.target_id },
        );
      }
      break;
    }
    case "many-to-one": {
      // Each source has at most one outbound edge (e.g. in-thread: each member in one thread).
      const sourceCount = await edgeStore.countBySource(
        input.source_id,
        input.edge_type,
      );
      if (sourceCount > 0) {
        throw new MymeError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Edge "${input.edge_type}" is many-to-one on the source side; source already has an outbound edge of this type`,
          { edge_type: input.edge_type, source_id: input.source_id },
        );
      }
      break;
    }
    case "many-to-many":
      // No uniqueness beyond the exact-duplicate guard handled above.
      break;
  }

  // Cycle prevention for parent-of and supersedes. Walk outbound edges of the
  // type starting from the proposed target; if the proposed source is reached,
  // creating the edge would close a cycle.
  if (input.edge_type === "parent-of" || input.edge_type === "supersedes") {
    if (
      await wouldCreateCycle(
        edgeStore,
        input.edge_type,
        input.source_id,
        input.target_id,
      )
    ) {
      throw new MymeError(
        ErrorCode.EDGE_CYCLE,
        `Edge "${input.edge_type}" would close a cycle`,
        {
          edge_type: input.edge_type,
          source_id: input.source_id,
          target_id: input.target_id,
        },
      );
    }
  }

  return schema;
}

/**
 * Cycle check (iterative BFS). Returns true if an edge source->target would
 * close a loop on the given edge_type.
 *
 * For parent-of: source=parent, target=child. Walk outbound parent-of from
 * target (child): those are the child's own children, grandchildren, etc.
 * If proposed source (the parent-to-be) is reachable that way, the parent
 * is already a descendant of its future child — cycle.
 *
 * For supersedes: source=newer, target=older. Walk outbound supersedes
 * from target (older): those are things target supersedes (even older).
 * If proposed source (the newer-to-be) appears, the newer is actually in
 * the older-chain — cycle.
 */
async function wouldCreateCycle(
  edgeStore: EdgeStore,
  edgeType: string,
  proposedSource: string,
  proposedTarget: string,
): Promise<boolean> {
  const visited = new Set<string>();
  const frontier: string[] = [proposedTarget];
  const MAX_DEPTH = 10000; // guard against degenerate graphs
  let steps = 0;

  while (frontier.length > 0 && steps < MAX_DEPTH) {
    const next = frontier.shift();
    if (!next) break;
    if (visited.has(next)) continue;
    visited.add(next);
    if (next === proposedSource) return true;
    const outbound = await edgeStore.listOutboundOfType(next, edgeType);
    for (const e of outbound) {
      if (!visited.has(e.target_id)) frontier.push(e.target_id);
    }
    steps++;
  }
  return false;
}

/** Lightweight row-shape → Edge helper, dialect-agnostic. */
export function rowToEdge(row: {
  id: string;
  tenant_id: string | null;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: string;
  created_at: string;
  updated_at: string;
}): Edge {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      properties = parsed as Record<string, unknown>;
    }
  } catch {
    // corrupt row — fall back to empty properties.
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type,
    properties,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
