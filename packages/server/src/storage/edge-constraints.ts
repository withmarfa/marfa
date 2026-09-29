import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  satisfiesEdgeConstraint,
} from "@withmarfa/shared";
import type { Edge, EdgeTypeSchema } from "@withmarfa/shared";
import { depthInsideFolder } from "../folder-path.js";
import type { EdgeStore, ItemStore } from "./interface.js";

/**
 * Edge types that can reach around and close a cycle over more than one
 * edge — hierarchy for `parent-of`, version chain for `supersedes`. BFS is
 * skipped for every other edge type, where the graph is DAG-by-construction
 * or unordered. A self-loop is the exception and is refused on all of them,
 * because one edge closing on itself needs no walk to find.
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

const FOLDER_EDGE_TYPE = "in-folder";

/** Whether a target in this state takes no new edge of this type. */
export function closedToNewEdge(
  edgeType: string,
  targetState: string,
): boolean {
  return edgeType === FOLDER_EDGE_TYPE && targetState === "revoked";
}

function propertyRefusal(key: string, message: string): MarfaError {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message, {
    errors: [{ path: `properties.${key}`, message }],
  });
}

/**
 * Holds an edge's properties, as they would stand after the write, to what
 * its type requires. Only `in-folder` requires anything: a `path` naming a
 * file inside the folder, and nothing else.
 */
export function assertEdgeProperties(
  edgeType: string,
  properties: Record<string, unknown> | undefined,
): void {
  if (edgeType !== FOLDER_EDGE_TYPE) return;
  const { path, ...rest } = properties ?? {};
  const [undeclared] = Object.keys(rest);
  if (undeclared !== undefined) {
    throw propertyRefusal(
      undeclared,
      `Edge "${edgeType}" declares no property "${undeclared}"`,
    );
  }
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
    throw propertyRefusal(
      "path",
      `Edge "${edgeType}" takes a "path" of 1 to 1024 characters`,
    );
  }
  if ((depthInsideFolder(path) ?? 0) < 1) {
    throw propertyRefusal(
      "path",
      `"${path}" is not a file inside the folder: write a path relative to its root, with "/" between names, that does not climb out of it`,
    );
  }
}

/**
 * A self-loop is the shortest cycle there is, so it answers `edge_cycle`
 * like any longer one: what the caller got wrong is the shape of the edge,
 * not the length of the path back. It needs no walk, which is why it is
 * refused on every edge type while the BFS below runs on two.
 *
 * One site, reached by every door, and deliberately after the edge type is
 * resolved: a proposal naming a type that does not exist has a worse problem
 * than its endpoints, and answering `edge_cycle` for it would describe the
 * wrong mistake.
 */
function assertNotSelfLoop(
  sourceId: string,
  targetId: string,
  edgeType: string,
): void {
  if (sourceId !== targetId) return;
  throw new MarfaError(
    ErrorCode.EDGE_CYCLE,
    `Edge source and target must be different items`,
    { edge_type: edgeType },
  );
}

/**
 * The one answer for a target that is missing or that the caller may not
 * read. Every door builds it here, so the two cannot drift apart.
 */
export function edgeTargetNotFound(targetId: string): MarfaError {
  return new MarfaError(
    ErrorCode.ITEM_NOT_FOUND,
    `Edge target item not found: ${targetId}`,
  );
}

/** The same one answer for a source. */
export function edgeSourceNotFound(sourceId: string): MarfaError {
  return new MarfaError(
    ErrorCode.ITEM_NOT_FOUND,
    `Edge source item not found: ${sourceId}`,
  );
}

export interface EdgeProposal {
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
}

/**
 * Enforces edge-creation invariants across a batch of proposed edges:
 *
 * 1. Edge type exists (core or custom registry).
 * 2. Source and target items both exist, and the caller may read both
 *    types: an end it may not read is answered as missing.
 * 3. Source type satisfies source_type_constraints (inheritance-aware).
 * 4. Target type satisfies target_type_constraints (inheritance-aware).
 * 5. Cardinality holds per edge type (DB edges + earlier proposals in the batch).
 * 6. Exact duplicate (source, target, edge_type) rejected — both DB and in-batch.
 * 7. A self-loop is rejected on every edge type; a longer cycle on
 *    parent-of and supersedes, considering proposed edges as part of the
 *    graph. Both answer `edge_cycle`.
 * 8. The properties are what the edge type requires, and an `in-folder`
 *    edge does not target a revoked folder unless `replay` says an archive
 *    recorded it.
 *
 * `replacing` names a stored edge the one proposal moves, which the
 * cardinality counts leave out.
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
  mayRead: (type: string) => boolean,
  opts: { replay?: boolean; replacing?: Edge } = {},
): Promise<EdgeTypeSchema[]> {
  if (proposals.length === 0) return [];

  // Zip each proposal with its schema once, so no downstream loop has to
  // realign the two lists.
  interface ResolvedProposal {
    p: EdgeProposal;
    schema: EdgeTypeSchema;
  }
  const resolved: ResolvedProposal[] = [];
  for (const p of proposals) {
    const schema = getEdgeTypeSchema(p.edge_type);
    if (!schema) {
      throw new MarfaError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Unknown edge type: ${p.edge_type}`,
      );
    }
    assertNotSelfLoop(p.source_id, p.target_id, p.edge_type);
    assertEdgeProperties(p.edge_type, p.properties);
    resolved.push({ p, schema });
  }

  // Step 3: item existence + type in one batched fetch.
  const itemIds = new Set<string>();
  for (const { p } of resolved) {
    itemIds.add(p.source_id);
    itemIds.add(p.target_id);
  }
  const itemMap = await itemStore.getMany(Array.from(itemIds));
  for (const { p, schema } of resolved) {
    const source = itemMap.get(p.source_id);
    const target = itemMap.get(p.target_id);
    // Before every check that reads either end, so a caller cannot tell a
    // row it may not read from no row, nor learn the type of one.
    if (!source || !mayRead(source.type)) {
      throw edgeSourceNotFound(p.source_id);
    }
    if (!target || !mayRead(target.type)) {
      throw edgeTargetNotFound(p.target_id);
    }
    // Endpoint types resolve through the registry, exactly as the edge type
    // itself did above, so a constraint naming a runtime-registered type
    // resolves like one naming a shipped type.
    if (!satisfiesEdgeConstraint(source.type, schema.source_type_constraints)) {
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
    if (!satisfiesEdgeConstraint(target.type, schema.target_type_constraints)) {
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
    if (closedToNewEdge(p.edge_type, target.state) && opts.replay !== true) {
      throw new MarfaError(
        ErrorCode.EDGE_CONSTRAINT_VIOLATION,
        `Folder ${p.target_id} is revoked and takes no new placement`,
        {
          edge_type: p.edge_type,
          target_id: p.target_id,
          constraint: "revoked",
        },
      );
    }
    if (
      p.edge_type === COLLECTION_EDGE_TYPE &&
      satisfiesEdgeConstraint(source.type, schema.target_type_constraints)
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
  const existsSet = await edgeStore.existsExactBatch(proposals);

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
    edgeStore.countsBySourceBatch(Array.from(needSourceCount.values())),
    edgeStore.countsByTargetBatch(Array.from(needTargetCount.values())),
  ]);
  const moving = opts.replacing;
  if (moving !== undefined) {
    // The edge being moved leaves its old ends, so it is not a second one there.
    for (const [counts, end] of [
      [sourceCounts, moving.source_id],
      [targetCounts, moving.target_id],
    ] as const) {
      const key = `${end}|${moving.edge_type}`;
      const held = counts.get(key);
      if (held !== undefined) counts.set(key, held - 1);
    }
  }

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

    // The cycles that need a walk. A self-loop is already refused above, on
    // every type; BFS sees the DB graph plus every prior in-batch proposal of
    // the same type.
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
  input: EdgeProposal,
  mayRead: (type: string) => boolean,
): Promise<EdgeTypeSchema> {
  const schemas = await assertEdgesCanBeCreated(
    edgeStore,
    itemStore,
    [input],
    mayRead,
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
      outbound = await edgeStore.listOutboundOfType(next, edgeType);
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

/** Lightweight row-shape → Edge helper. */
export function rowToEdge(row: {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: string;
  created_at: string;
  updated_at: string;
  version: number;
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
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type,
    properties,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}
