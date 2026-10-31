// Imports nothing, so the core catalog generator can read it without the server.

/**
 * Edge types that can reach around and close a cycle over more than one
 * edge: hierarchy for `parent-of`, version chain for `supersedes`. Reachability
 * is skipped for every other edge type, where the graph is DAG-by-construction
 * or unordered. A self-loop is the exception and is refused on all of them,
 * because one edge closing on itself needs no walk to find.
 */
export const CYCLE_RISK_EDGE_TYPES = new Set(["parent-of", "supersedes"]);

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
 * rather than a list: a type declaring `container` is refused as a source the
 * day it declares it, with nothing here to update. It is also what makes a
 * membership cycle impossible without a reachability query: every cycle needs a container
 * standing as a source somewhere, and no such edge can exist. Hierarchy is
 * what `parent-of` is for, and mixing the two gives an item two competing
 * notions of where it sits.
 */
const COLLECTION_EDGE_TYPE = "in-collection";

/** Whether the server walks this edge type for a cycle longer than one edge. */
export function isAcyclicEdgeType(edgeType: string): boolean {
  return CYCLE_RISK_EDGE_TYPES.has(edgeType);
}

/** Whether this edge type refuses a source its own target constraints admit. */
export function isFlatEdgeType(edgeType: string): boolean {
  return edgeType === COLLECTION_EDGE_TYPE;
}
