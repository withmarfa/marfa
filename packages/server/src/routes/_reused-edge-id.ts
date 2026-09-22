import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Edge } from "@withmarfa/shared";

/** The triple an edge is, as a write states it. */
interface EdgeTriple {
  source_id: string;
  target_id: string;
  edge_type: string;
}

/**
 * The refusal for a caller-minted edge id that already names a different
 * edge, shared by the single door and the bulk one.
 *
 * Shared rather than written twice because the code a caller gets must not
 * depend on how many edges it batched. The single door had this comparison
 * inline and the bulk door had none at all, so the same mistake came back
 * as `id_reused` from one and as a bare primary-key collision from the
 * other, which is the inconsistency one code exists to remove.
 */
export function refuseReusedEdgeId(existing: Edge, incoming: EdgeTriple): void {
  const differs = [
    existing.source_id === incoming.source_id ? null : "source_id",
    existing.target_id === incoming.target_id ? null : "target_id",
    existing.edge_type === incoming.edge_type ? null : "edge_type",
  ].filter((field): field is string => field !== null);
  if (differs.length === 0) return;
  const last = differs.at(-1) ?? "triple";
  const named =
    differs.length < 2
      ? last
      : `${differs.slice(0, -1).join(", ")} and ${last}`;
  throw new MarfaError(
    ErrorCode.ID_REUSED,
    `Edge id ${existing.id} already names an edge with a different ${named}`,
    { existing_id: existing.id, differs },
  );
}
