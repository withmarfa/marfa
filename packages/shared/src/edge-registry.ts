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

// Core edge types are global — shipped with @withmarfa/types and shared by
// every space. This map is read-only after construction.
const _coreRegistry = new Map<string, EdgeTypeSchema>(
  ALL_EDGE_TYPES.map((schema) => [schema.id, schema]),
);

/**
 * Custom edge types are space-scoped. The outer key is the owning space's
 * id; each space gets its own inner id→schema map. A custom edge type
 * registered by space A is therefore invisible to space B's lookups —
 * the isolation that keeps one space's relationship vocabulary out of
 * another's. The sentinel `NULL_SPACE` key holds custom edge types with no
 * space (the platform-registered set) so the
 * keys-mode flow is unaffected.
 */
const _customBySpace = new Map<string, Map<string, EdgeTypeSchema>>();

// Sentinel for custom edge types with no owning space — the platform
// self-hosts and platform-registered types. An empty string can't collide
// with a real space id (ids are non-empty), so it's a safe bucket key.
const NULL_SPACE = "";

function spaceKey(spaceId: string | null | undefined): string {
  return spaceId ?? NULL_SPACE;
}

/**
 * The core edge-type registry — the eight global edge types by identifier.
 * Custom (space-scoped) edge types are NOT exposed here; consumers that need
 * the full set for a space call `listEdgeTypes(spaceId)`. The OAuth scope
 * allow-list reads this for the static core-scope enumeration.
 */
export const EDGE_TYPE_REGISTRY: ReadonlyMap<string, EdgeTypeSchema> =
  _coreRegistry;

/**
 * Resolves an edge-type schema for a given space. Core edge types resolve
 * globally; custom edge types resolve only within their owning space. A
 * lookup with no `spaceId` sees core types plus the null-space bucket
 * (the platform-registered set), never another space's custom types.
 */
export function getEdgeTypeSchema(
  edgeTypeId: string,
  spaceId?: string | null,
): EdgeTypeSchema | undefined {
  const core = _coreRegistry.get(edgeTypeId);
  if (core) return core;
  return _customBySpace.get(spaceKey(spaceId))?.get(edgeTypeId);
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
 * Registers a custom edge-type schema into the space's overlay. Core edge
 * types are never registered here (they live in the global map); callers
 * filter them out before calling. `spaceId` is the owning space — omit it
 * only for the null-space bucket (the platform-registered set).
 */
export function registerEdgeTypeSchema(
  schema: EdgeTypeSchema,
  spaceId?: string | null,
): void {
  const key = spaceKey(spaceId);
  let bucket = _customBySpace.get(key);
  if (!bucket) {
    bucket = new Map<string, EdgeTypeSchema>();
    _customBySpace.set(key, bucket);
  }
  bucket.set(schema.id, schema);
}

/** Removes a custom edge-type schema from the space's overlay. */
export function unregisterEdgeTypeSchema(
  id: string,
  spaceId?: string | null,
): void {
  _customBySpace.get(spaceKey(spaceId))?.delete(id);
}

/**
 * Lists every edge type visible to a space: the global core set plus that
 * space's own custom edge types. With no `spaceId`, returns core plus the
 * null-space bucket — never another space's custom types.
 */
export function listEdgeTypes(spaceId?: string | null): EdgeTypeSchema[] {
  const custom = _customBySpace.get(spaceKey(spaceId));
  if (!custom) return [..._coreRegistry.values()];
  return [..._coreRegistry.values(), ...custom.values()];
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
 * which is every integration publisher who is not us; a role is something the
 * type being pointed at declares about itself, so the edge stays closed on
 * meaning while staying open on membership.
 *
 * Unknown types (not in TYPE_REGISTRY) are rejected — the server requires
 * both endpoints to carry valid known types before validating constraints.
 */
export function satisfiesEdgeConstraint(
  typeId: string,
  constraints: readonly string[],
  spaceId?: string | null,
): boolean {
  if (constraints.length === 0) return true;
  if (constraints.includes("*")) return true;
  // Unknown item types can't be reasoned about — fail closed. Resolve within
  // the space so a custom item type used as an edge endpoint is recognized
  // (core/system types resolve regardless of space).
  if (!getTypeSchema(typeId, spaceId)) return false;
  for (const allowed of constraints) {
    if (allowed === "*") return true;
    if (isRoleConstraint(allowed)) {
      // An unknown role matches nothing rather than throwing: the authoring
      // validators refuse one, so reaching here means a stored edge type
      // predates the role or was written past them, and refusing the write is
      // the fail-closed answer.
      const role = roleFromConstraint(allowed);
      if (role !== undefined && typeHasRole(typeId, role, spaceId)) return true;
      continue;
    }
    if (isSubtypeOf(typeId, allowed, spaceId)) return true;
  }
  return false;
}
