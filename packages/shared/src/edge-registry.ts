import {
  ALL_EDGE_TYPES,
  isRoleConstraint,
  roleFromConstraint,
} from "@withmarfa/types";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
} from "@withmarfa/types";
import { getTypeSchema, isSubtypeOf, typeHasRole } from "./type-registry.js";

// Re-export types so consumers of @withmarfa/shared can reach them without
// depending on @withmarfa/types directly.
export type { EdgeCardinality, EdgeCascade, EdgeTypeSchema };
export { ALL_EDGE_TYPES };

// Core edge types are shipped with @withmarfa/types and resolve for every
// caller. This map is read-only after construction.
const _coreRegistry = new Map<string, EdgeTypeSchema>(
  ALL_EDGE_TYPES.map((schema) => [schema.id, schema]),
);

/** Custom edge types registered on this instance, keyed by id. One bucket:
 *  a registration is visible to every caller. */
const _customRegistry = new Map<string, EdgeTypeSchema>();

/**
 * The core edge-type registry — the eight shipped edge types by identifier.
 * Custom edge types are NOT exposed here; consumers that need the full set
 * call `listEdgeTypes()`. The OAuth scope allow-list reads this for the
 * static core-scope enumeration.
 */
export const EDGE_TYPE_REGISTRY: ReadonlyMap<string, EdgeTypeSchema> =
  _coreRegistry;

/** Resolves an edge-type schema: the shipped set, then the instance's own
 *  registrations. */
export function getEdgeTypeSchema(
  edgeTypeId: string,
): EdgeTypeSchema | undefined {
  const core = _coreRegistry.get(edgeTypeId);
  if (core) return core;
  return _customRegistry.get(edgeTypeId);
}

/**
 * Core edge types live in the edge-registry bootstrap array (shipped with
 * @withmarfa/types). Everything else is custom and may be registered at runtime.
 */
const CORE_EDGE_TYPE_IDS: ReadonlySet<string> = new Set(
  ALL_EDGE_TYPES.map((e) => e.id),
);

export function isCoreEdgeType(edgeTypeId: string): boolean {
  return CORE_EDGE_TYPE_IDS.has(edgeTypeId);
}

/**
 * Registers a custom edge-type schema. Core edge types are never registered
 * here (they live in the global map); callers filter them out before calling.
 */
export function registerEdgeTypeSchema(schema: EdgeTypeSchema): void {
  const bucket = _customRegistry;
  bucket.set(schema.id, schema);
}

/** Removes a custom edge-type schema from the runtime overlay. */
export function unregisterEdgeTypeSchema(id: string): void {
  _customRegistry.delete(id);
}

/** Lists every edge type: the shipped core set plus the instance's own
 *  custom edge types. */
export function listEdgeTypes(): EdgeTypeSchema[] {
  return [..._coreRegistry.values(), ..._customRegistry.values()];
}

// ---------------------------------------------------------------------------
// Constraint resolution (inheritance-aware)
// ---------------------------------------------------------------------------

/**
 * Returns true if `typeId` satisfies a type-constraint list. Three entry
 * forms, any one of which is enough:
 *
 * - `*` matches anything.
 * - `role:<name>` matches every type declaring that role, its own or
 *   inherited.
 * - anything else is a type identifier, matched inheritance-aware, so a
 *   subtype satisfies an ancestor's entry.
 *
 * The role form exists because a list of names can only ever admit the types
 * whoever wrote the edge had already thought of. A core edge naming its
 * permitted endpoints is unextendable by anyone who cannot edit the core edge,
 * which is every connector publisher who is not us; a role is something the
 * type being pointed at declares about itself, so the edge stays closed on
 * meaning while staying open on membership.
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
  // Unknown item types can't be reasoned about — fail closed. Resolved
  // through the registry so a custom item type used as an edge endpoint is
  // recognized alongside the shipped ones.
  if (!getTypeSchema(typeId)) return false;
  for (const allowed of constraints) {
    if (allowed === "*") return true;
    if (isRoleConstraint(allowed)) {
      // An unknown role matches nothing rather than throwing: the authoring
      // validators refuse one, so reaching here means a stored edge type
      // predates the role or was written past them, and refusing the write is
      // the fail-closed answer.
      const role = roleFromConstraint(allowed);
      if (role !== undefined && typeHasRole(typeId, role)) return true;
      continue;
    }
    if (isSubtypeOf(typeId, allowed)) return true;
  }
  return false;
}
