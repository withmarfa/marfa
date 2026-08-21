import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  satisfiesEdgeConstraint,
} from "@withmarfa/shared";
import type { Edge, EdgeTypeSchema } from "@withmarfa/shared";
import type { EdgeStore, ItemStore } from "./interface.js";

/**
 * Edge types that can introduce graph cycles — hierarchy for `parent-of`,
 * version chain for `supersedes`. BFS cycle-detection is skipped for every
 * other edge type where the graph is DAG-by-construction or unordered.
 */
const CYCLE_RISK_EDGE_TYPES = new Set(["parent-of", "supersedes"]);

/**
 * Collection membership is a flat relation on purpose: a container holds
 * items, never other containers. The declarative target constraint pins the
 * target to the container family, but nothing declarative can say "and the
 * source must not be one of those", so the refusal lives here.
 *
 * The refused-source rule is the edge's own target constraint, re-evaluated
 * against the source and read from the same resolved schema, never a second
 * literal: a copy drifted once when the membership edge gained two container
 * types the copy did not, and two series could then hold each other. That
 * derivation is what makes this survive the target constraint becoming a role
 * rather than a list — a type declaring `container` is refused as a source the
 * day it declares it, with nothing here to update. It is also what makes a
 * membership cycle impossible without a BFS: every cycle needs a container
 * standing as a source somewhere, and no such edge can exist. Hierarchy is
 * what `parent-of` is for, and mixing the two gives an item two competing
 * notions of where it sits.
 */
const COLLECTION_EDGE_TYPE = "in-collection";

export interface EdgeProposal {
  source_id: string;
  target_id: string;
  edge_type: string;
}

/**
 * Enforces edge-creation invariants across a batch of proposed edges:
 *
 * 1. Edge type exists (core or custom registry).
 * 2. Source and target items exist and belong to the same space.
 * 3. Source type satisfies source_type_constraints (inheritance-aware).
 * 4. Target type satisfies target_type_constraints (inheritance-aware).
 * 5. Cardinality holds per edge type (DB edges + earlier proposals in the batch).
 * 6. Exact duplicate (source, target, edge_type) rejected — both DB and in-batch.
 * 7. Cycles rejected for parent-of and supersedes, considering proposed edges
 *    as part of the graph.
 *
 * Throws `MarfaError` on the first failure encountered in input order, matching
 * the sequential-validation behavior the single-edge entry point exposed.
 * Returns the resolved edge-type schemas in input order.
 *
 * Runs inside the caller's transaction so a failed check rolls back the write.
 */
export async function assertEdgesCanBeCreated(
  edgeStore: EdgeStore,
  itemStore: ItemStore,
  proposals: EdgeProposal[],
  opts: { space_id?: string } = {},
): Promise<EdgeTypeSchema[]> {
  if (proposals.length === 0) return [];

  // Step 1 + 2: schema resolve (in-memory) + self-edge guard. Zip each
  // proposal with its schema once so downstream loops never have to realign.
  interface ResolvedProposal {
    p: EdgeProposal;
    schema: EdgeTypeSchema;
  }
  const resolved: ResolvedProposal[] = [];
  for (const p of proposals) {
    // Resolve the edge-type schema within the caller's space: core types are
    // global, custom types resolve only for their owning space. A space that
    // references another space's custom edge type sees "unknown edge type".
    const schema = getEdgeTypeSchema(p.edge_type, opts.space_id);
    if (!schema) {
      throw new MarfaError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Unknown edge type: ${p.edge_type}`,
      );
    }
    if (p.source_id === p.target_id) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Edge source and target must be different items`,
        { edge_type: p.edge_type },
      );
    }
    resolved.push({ p, schema });
  }

  // Step 3: item existence + type in one batched fetch.
  const itemIds = new Set<string>();
  for (const { p } of resolved) {
    itemIds.add(p.source_id);
    itemIds.add(p.target_id);
  }
  const itemMap = await itemStore.getMany(Array.from(itemIds), opts.space_id);
  for (const { p, schema } of resolved) {
    const source = itemMap.get(p.source_id);
    const target = itemMap.get(p.target_id);
    if (!source) {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        `Edge source item not found: ${p.source_id}`,
      );
    }
    if (!target) {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        `Edge target item not found: ${p.target_id}`,
      );
    }
    // Endpoint types resolve within the caller's space, exactly as the edge
    // type itself did above. Core and system types resolve regardless, so
    // omitting the space only ever mattered for a constraint naming a
    // space-registered type — which no core edge had until `in-collection`,
    // and which every custom edge type naming a custom type has always had.
    if (
      !satisfiesEdgeConstraint(
        source.type,
        schema.source_type_constraints,
        opts.space_id,
      )
    ) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Edge "${p.edge_type}" does not allow source type "${source.type}"`,
        {
          edge_type: p.edge_type,
          source_type: source.type,
          allowed: schema.source_type_constraints,
        },
      );
    }
    if (
      !satisfiesEdgeConstraint(
        target.type,
        schema.target_type_constraints,
        opts.space_id,
      )
    ) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Edge "${p.edge_type}" does not allow target type "${target.type}"`,
        {
          edge_type: p.edge_type,
          target_type: target.type,
          allowed: schema.target_type_constraints,
        },
      );
    }
    if (
      p.edge_type === COLLECTION_EDGE_TYPE &&
      satisfiesEdgeConstraint(
        source.type,
        schema.target_type_constraints,
        opts.space_id,
      )
    ) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Edge "${p.edge_type}" does not nest collections; use "parent-of" for hierarchy`,
        {
          edge_type: p.edge_type,
          source_id: p.source_id,
          source_type: source.type,
          constraint: "nesting",
        },
      );
    }
  }

  // Step 4 + 5: pre-fetch existence + cardinality counts in grouped queries.
  // Fence every store read to the caller's space so duplicate/cardinality
  // checks never fold in another space's edges.
  const existsSet = await edgeStore.existsExactBatch(proposals, opts.space_id);

  const needSourceCount = new Map<
    string,
    { source_id: string; edge_type: string }
  >();
  const needTargetCount = new Map<
    string,
    { target_id: string; edge_type: string }
  >();
  for (const { p, schema } of resolved) {
    const needsSource =
      schema.cardinality === "one-to-one" ||
      schema.cardinality === "many-to-one";
    const needsTarget =
      schema.cardinality === "one-to-one" ||
      schema.cardinality === "one-to-many";
    if (needsSource) {
      const key = `${p.source_id}|${p.edge_type}`;
      if (!needSourceCount.has(key)) {
        needSourceCount.set(key, {
          source_id: p.source_id,
          edge_type: p.edge_type,
        });
      }
    }
    if (needsTarget) {
      const key = `${p.target_id}|${p.edge_type}`;
      if (!needTargetCount.has(key)) {
        needTargetCount.set(key, {
          target_id: p.target_id,
          edge_type: p.edge_type,
        });
      }
    }
  }
  const [sourceCounts, targetCounts] = await Promise.all([
    edgeStore.countsBySourceBatch(
      Array.from(needSourceCount.values()),
      opts.space_id,
    ),
    edgeStore.countsByTargetBatch(
      Array.from(needTargetCount.values()),
      opts.space_id,
    ),
  ]);

  // In-batch accumulators — each proposal that passes validation counts
  // toward the next proposal's cardinality check, matching the old
  // sequential "create, next check sees it" behavior.
  const seen = new Set<string>();
  const inBatchSourceCount = new Map<string, number>();
  const inBatchTargetCount = new Map<string, number>();

  // Cycle-check walker — cached DB reads + layered in-batch edges.
  const outboundCache = new Map<string, Edge[]>();
  const pendingByType = new Map<
    string,
    { source_id: string; target_id: string }[]
  >();

  for (const { p, schema } of resolved) {
    // Exact duplicate — in-batch repeat or existing DB row.
    const dupKey = `${p.source_id}|${p.target_id}|${p.edge_type}`;
    if (seen.has(dupKey) || existsSet.has(dupKey)) {
      // `constraint` is the machine-readable discriminator: a duplicate is
      // the one refusal an idempotent writer may safely treat as success,
      // and message text is not a contract.
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Edge "${p.edge_type}" already exists between these items`,
        {
          edge_type: p.edge_type,
          source_id: p.source_id,
          target_id: p.target_id,
          constraint: "duplicate",
        },
      );
    }

    // Cardinality is judged direction-correct: for each edge type the
    // constrained side is fixed by the spec (parent-of counts children per
    // parent, not parents per child). Combine the DB pre-count with any
    // in-batch proposals that already passed.
    const srcKey = `${p.source_id}|${p.edge_type}`;
    const tgtKey = `${p.target_id}|${p.edge_type}`;
    const dbSourceCount = sourceCounts.get(srcKey) ?? 0;
    const dbTargetCount = targetCounts.get(tgtKey) ?? 0;
    const batchSourceCount = inBatchSourceCount.get(srcKey) ?? 0;
    const batchTargetCount = inBatchTargetCount.get(tgtKey) ?? 0;
    const totalSource = dbSourceCount + batchSourceCount;
    const totalTarget = dbTargetCount + batchTargetCount;

    switch (schema.cardinality) {
      case "one-to-one": {
        if (totalSource > 0) {
          throw new MarfaError(
            ErrorCode.EDGE_CONSTRAINT_VIOLATION,
            `Edge "${p.edge_type}" is one-to-one; source already has one outbound edge of this type`,
            {
              edge_type: p.edge_type,
              source_id: p.source_id,
              constraint: "cardinality",
            },
          );
        }
        if (totalTarget > 0) {
          throw new MarfaError(
            ErrorCode.EDGE_CONSTRAINT_VIOLATION,
            `Edge "${p.edge_type}" is one-to-one; target already has one inbound edge of this type`,
            {
              edge_type: p.edge_type,
              target_id: p.target_id,
              constraint: "cardinality",
            },
          );
        }
        break;
      }
      case "one-to-many": {
        if (totalTarget > 0) {
          throw new MarfaError(
            ErrorCode.EDGE_CONSTRAINT_VIOLATION,
            `Edge "${p.edge_type}" is one-to-many on the target side; target already has an inbound edge of this type`,
            {
              edge_type: p.edge_type,
              target_id: p.target_id,
              constraint: "cardinality",
            },
          );
        }
        break;
      }
      case "many-to-one": {
        if (totalSource > 0) {
          throw new MarfaError(
            ErrorCode.EDGE_CONSTRAINT_VIOLATION,
            `Edge "${p.edge_type}" is many-to-one on the source side; source already has an outbound edge of this type`,
            {
              edge_type: p.edge_type,
              source_id: p.source_id,
              constraint: "cardinality",
            },
          );
        }
        break;
      }
      case "many-to-many":
        // No uniqueness beyond the exact-duplicate guard handled above.
        break;
    }

    // Cycle check — only the two edge types that can form them. BFS sees the
    // DB graph plus every prior in-batch proposal of the same type.
    if (CYCLE_RISK_EDGE_TYPES.has(p.edge_type)) {
      const pending = pendingByType.get(p.edge_type) ?? [];
      if (
        await wouldCreateCycle(
          edgeStore,
          p.edge_type,
          p.source_id,
          p.target_id,
          outboundCache,
          pending,
          opts.space_id,
        )
      ) {
        throw new MarfaError(
          ErrorCode.EDGE_CYCLE,
          `Edge "${p.edge_type}" would close a cycle`,
          {
            edge_type: p.edge_type,
            source_id: p.source_id,
            target_id: p.target_id,
          },
        );
      }
    }

    // Proposal cleared — register it for subsequent in-batch checks.
    seen.add(dupKey);
    inBatchSourceCount.set(srcKey, batchSourceCount + 1);
    inBatchTargetCount.set(tgtKey, batchTargetCount + 1);
    if (CYCLE_RISK_EDGE_TYPES.has(p.edge_type)) {
      const pending = pendingByType.get(p.edge_type) ?? [];
      pending.push({ source_id: p.source_id, target_id: p.target_id });
      pendingByType.set(p.edge_type, pending);
    }
  }

  return resolved.map((r) => r.schema);
}

/** Thin single-edge wrapper — preserves the pre-batch call shape. */
export async function assertEdgeCanBeCreated(
  edgeStore: EdgeStore,
  itemStore: ItemStore,
  input: {
    source_id: string;
    target_id: string;
    edge_type: string;
    space_id?: string;
  },
): Promise<EdgeTypeSchema> {
  const schemas = await assertEdgesCanBeCreated(
    edgeStore,
    itemStore,
    [
      {
        source_id: input.source_id,
        target_id: input.target_id,
        edge_type: input.edge_type,
      },
    ],
    { space_id: input.space_id },
  );
  const [only] = schemas;
  if (!only) {
    throw new Error(
      "assertEdgesCanBeCreated returned empty schema list for single-edge input",
    );
  }
  return only;
}

/**
 * Cycle check (iterative BFS). Returns true if an edge source->target would
 * close a loop on the given edge_type. Layers in-batch pending edges on top
 * of the DB graph so multi-edge batches whose individual edges are each
 * acyclic but which together close a cycle are still rejected.
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
  outboundCache: Map<string, Edge[]>,
  pendingEdges: { source_id: string; target_id: string }[],
  spaceId?: string,
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
    let outbound = outboundCache.get(next);
    if (!outbound) {
      outbound = await edgeStore.listOutboundOfType(next, edgeType, spaceId);
      outboundCache.set(next, outbound);
    }
    for (const e of outbound) {
      if (!visited.has(e.target_id)) frontier.push(e.target_id);
    }
    // Layer earlier in-batch proposals into the traversal.
    for (const pending of pendingEdges) {
      if (pending.source_id === next && !visited.has(pending.target_id)) {
        frontier.push(pending.target_id);
      }
    }
    steps++;
  }
  return false;
}

/** Lightweight row-shape → Edge helper, dialect-agnostic. */
export function rowToEdge(row: {
  id: string;
  space_id: string | null;
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
    space_id: row.space_id,
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type,
    properties,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
