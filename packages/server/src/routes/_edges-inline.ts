import { ErrorCode, MarfaError, isValidId } from "@withmarfa/shared";

import {
  assertEdgesCanBeCreated,
  type EdgeProposal,
} from "../storage/edge-constraints.js";
import type { Storage } from "../storage/interface.js";

/**
 * Replace the outbound edges of `itemId` for the listed edge types,
 * setting the new target list per type. For each `[edgeType, targets]`
 * entry: every existing edge from `itemId` of that type is deleted,
 * then one edge per target is created. Edge types not listed in `edges`
 * are left untouched.
 *
 * Used by `/items/bulk` upsert and the natural-key upsert short-circuit
 * on `POST /items`. The proposed (post-delete) edge set is validated
 * through the same `assertEdgesCanBeCreated` checks the create path uses
 * — cardinality, type constraints, exact-duplicate, and the load-bearing
 * cycle check (`parent-of` / `supersedes`). Without it the upsert path
 * could re-introduce a graph cycle or a cardinality / type-constraint
 * violation that the first write rejected, and a poisoned cycle later
 * breaks cascade delete.
 *
 * The delete + create are not transactional on their own — the caller
 * MUST invoke this inside a `storage.runInTransaction` so a validation
 * failure rolls the deletes back. All three call sites do (the natural-key
 * short-circuit and both bulk branches). Validation runs after the deletes
 * but before any create, so a rejected set never lands a write; the
 * transaction unwinds the deletes.
 *
 * `assertEdgeWritable` is the caller's edge-type permission gate, run once
 * per listed edge type. It lives here rather than at each call site because
 * every route reaching this function reaches the same state, and a gate that
 * has to be remembered per route is a gate one of them will be missing — as
 * both bulk branches were. It is a required parameter for the same reason:
 * a new call site has to state an answer rather than inherit a default.
 *
 * The gate runs for every listed type including one whose target list is
 * empty. An empty list is not a no-op, it is a delete instruction: the
 * loop below removes every existing edge of that type and then creates
 * nothing. Gating only non-empty lists leaves the delete primitive
 * ungated, which is the half a create-only test passes straight over.
 */
export async function applyInlineEdges(
  storage: Storage,
  itemId: string,
  edges: Record<string, string[]>,
  tenantId: string | undefined,
  assertEdgeWritable: (edgeType: string) => void,
): Promise<void> {
  // Permission first, before any shape validation or write. A caller with
  // no edge permission must not be able to distinguish a malformed target
  // from a well-formed one it still may not write.
  for (const edgeType of Object.keys(edges)) {
    assertEdgeWritable(edgeType);
  }

  // Build and shape the proposals up front so a malformed target id is
  // rejected before any write — preserves the prior fail-fast behavior.
  const proposals: EdgeProposal[] = [];
  for (const [edgeType, targets] of Object.entries(edges)) {
    for (const target of targets) {
      if (!isValidId(target)) {
        throw new MarfaError(
          ErrorCode.INVALID_ID,
          `Invalid target id in edges.${edgeType}: ${target}`,
        );
      }
      if (target === itemId) {
        throw new MarfaError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Edge source and target must be different items`,
          { edge_type: edgeType },
        );
      }
      proposals.push({
        source_id: itemId,
        target_id: target,
        edge_type: edgeType,
      });
    }
  }

  // Delete first so cardinality / duplicate checks see the post-delete
  // graph: replacing this item's edges of a type must not collide with
  // the very edges being replaced.
  for (const edgeType of Object.keys(edges)) {
    await storage.edges.deleteBySource(itemId, edgeType, tenantId);
  }

  // Validate the full proposed set against the post-delete state. Throws
  // on the first violation (cardinality, type constraint, duplicate,
  // cycle), aborting the caller's transaction before any edge is recreated.
  await assertEdgesCanBeCreated(storage.edges, storage.items, proposals, {
    tenant_id: tenantId,
  });

  for (const p of proposals) {
    await storage.edges.createRaw(
      {
        source_id: p.source_id,
        target_id: p.target_id,
        edge_type: p.edge_type,
      },
      tenantId,
    );
  }
}
