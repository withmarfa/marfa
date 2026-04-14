import { ALL_EDGE_TYPES } from "@mymehq/types";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
} from "@mymehq/types";
import { isSubtypeOf, TYPE_REGISTRY } from "./type-registry.js";

// Re-export types so consumers of @mymehq/shared can reach them without
// depending on @mymehq/types directly.
export type { EdgeCardinality, EdgeCascade, EdgeTypeSchema };
export { ALL_EDGE_TYPES };

// Internal mutable map — exposed as ReadonlyMap to prevent accidental mutation.
const _registry = new Map<string, EdgeTypeSchema>(
  ALL_EDGE_TYPES.map((schema) => [schema.id, schema]),
);

/** The edge-type registry — all registered edge-type schemas by identifier. */
export const EDGE_TYPE_REGISTRY: ReadonlyMap<string, EdgeTypeSchema> =
  _registry;

/** Returns the edge-type schema for the given identifier, or undefined. */
export function getEdgeTypeSchema(edgeTypeId: string): EdgeTypeSchema | undefined {
  return _registry.get(edgeTypeId);
}

/**
 * Core edge types live in the edge-registry bootstrap array (shipped with
 * @mymehq/types). Everything else is custom and may be registered at runtime.
 */
const CORE_EDGE_TYPE_IDS: ReadonlySet<string> = new Set(
  ALL_EDGE_TYPES.map((e) => e.id),
);

export function isCoreEdgeType(edgeTypeId: string): boolean {
  return CORE_EDGE_TYPE_IDS.has(edgeTypeId);
}

/** Registers an edge-type schema into the in-memory registry. */
export function registerEdgeTypeSchema(schema: EdgeTypeSchema): void {
  _registry.set(schema.id, schema);
}

/** Removes an edge-type schema from the in-memory registry. */
export function unregisterEdgeTypeSchema(id: string): void {
  _registry.delete(id);
}

/** Lists every registered edge-type (core + custom). */
export function listEdgeTypes(): EdgeTypeSchema[] {
  return [..._registry.values()];
}

// ---------------------------------------------------------------------------
// Constraint resolution (inheritance-aware)
// ---------------------------------------------------------------------------

/**
 * Returns true if `typeId` satisfies a type-constraint list. A wildcard `*`
 * entry matches anything; otherwise the item's type must equal or be a
 * subtype of (via the type inheritance chain) one of the listed types.
 *
 * Unknown types (not in TYPE_REGISTRY) are rejected — the server requires
 * both endpoints to carry valid known types before validating constraints.
 */
export function satisfiesEdgeConstraint(
  typeId: string,
  constraints: readonly string[],
): boolean {
  if (constraints.length === 0) return true;
  if (constraints.includes("*")) return true;
  // Unknown item types can't be reasoned about — fail closed.
  if (!TYPE_REGISTRY.has(typeId)) return false;
  for (const allowed of constraints) {
    if (allowed === "*") return true;
    if (isSubtypeOf(typeId, allowed)) return true;
  }
  return false;
}
