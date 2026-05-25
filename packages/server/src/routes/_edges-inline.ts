import { ErrorCode, MarfaError, isValidId } from "@withmarfa/shared";

import type { Storage } from "../storage/interface.js";

/**
 * Replace the outbound edges of `itemId` for the listed edge types,
 * setting the new target list per type. For each `[edgeType, targets]`
 * entry: every existing edge from `itemId` of that type is deleted,
 * then one edge per target is created. Edge types not listed in `edges`
 * are left untouched.
 *
 * Used by `/items/bulk` upsert and the natural-key upsert short-circuit
 * on `POST /items` (T-038). Permissive — does not run the same
 * cardinality / type-constraint checks as `assertEdgesCanBeCreated`;
 * the bulk surface is best-effort and the natural-key short-circuit
 * matches that semantics for parity. Callers needing strict validation
 * should go through `POST /items` create (which calls
 * `assertEdgesCanBeCreated` before any writes).
 */
export async function applyInlineEdges(
  storage: Storage,
  itemId: string,
  edges: Record<string, string[]>,
  tenantId: string | undefined,
): Promise<void> {
  for (const [edgeType, targets] of Object.entries(edges)) {
    await storage.edges.deleteBySource(itemId, edgeType);
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
      await storage.edges.createRaw(
        { source_id: itemId, target_id: target, edge_type: edgeType },
        tenantId,
      );
    }
  }
}
