import {
  registryMapFacet,
  registryMapView,
  immutableRegistrySchema,
  stageRegistryEdge,
  removeRegistryEdge,
} from "./registry-view.js";
import {
  ALL_EDGE_TYPES,
  SHIPPED_EDGE_TYPE_SHAPES,
  isRoleConstraint,
  roleFromConstraint,
} from "@withmarfa/types";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
} from "@withmarfa/types";
import { getTypeSchema, isSubtypeOf, typeHasRole } from "./type-registry.js";
import { labelFromId, namedLabel } from "./type-label.js";

// Re-export types so consumers of @withmarfa/shared can reach them without
// depending on @withmarfa/types directly.
export type { EdgeCardinality, EdgeCascade, EdgeTypeSchema };
export { ALL_EDGE_TYPES, SHIPPED_EDGE_TYPE_SHAPES };

// Core edge types are shipped with @withmarfa/types and resolve for every
// caller. This map is read-only after construction.
const core = new Map<string, EdgeTypeSchema>(
  ALL_EDGE_TYPES.map((schema) => [schema.id, immutableRegistrySchema(schema)]),
);
const _coreRegistry = registryMapView(() => core);

const _customRegistry = registryMapFacet("edges");

/**
 * The core edge-type registry: the shipped edge types by identifier.
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
  stageRegistryEdge(schema);
}

/**
 * Reads a registered edge type from the JSON a database stores. A row written
 * before `label` was required may have none, and is read with the label its
 * id makes, as a registration that names none is. Nothing rewrites the row
 * until the type is replaced.
 */
export function edgeTypeFromStored(json: string): EdgeTypeSchema {
  const stored = JSON.parse(json) as Omit<EdgeTypeSchema, "label"> &
    Partial<Pick<EdgeTypeSchema, "label">>;
  // `label` follows `id`, where a registration puts it, so a stored row and
  // the same registration read the same when an archive restore compares them.
  const { id, label, ...rest } = stored;
  return { id, label: namedLabel(label) ?? labelFromId(id), ...rest };
}

/** Removes a custom edge-type schema from the runtime overlay. */
export function unregisterEdgeTypeSchema(id: string): void {
  removeRegistryEdge(id);
}

/**
 * The edge type holding `name` as its id or its reverse name, other than
 * `exceptId`. A folder reads a frontmatter key as the edge type it names, so
 * every such name belongs to one type.
 */
export function edgeNameHolder(
  name: string,
  exceptId?: string,
): string | undefined {
  for (const schema of listEdgeTypes()) {
    if (schema.id === exceptId) continue;
    if (schema.id === name || schema.reverse_name === name) return schema.id;
  }
  return undefined;
}

/**
 * Each name, an id or a reverse name, that more than one edge type in the
 * registry holds, with the types holding it. Empty on an instance whose
 * registrations were all made under the name rules; a registration made
 * before a shipped type took a reverse name can collide with it.
 */
export function edgeNameCollisions(): Record<string, string[]> {
  const holders = new Map<string, string[]>();
  for (const schema of listEdgeTypes()) {
    for (const name of [schema.id, schema.reverse_name]) {
      if (name === undefined) continue;
      holders.set(name, [...(holders.get(name) ?? []), schema.id]);
    }
  }
  return Object.fromEntries(
    [...holders].filter(([, types]) => types.length > 1),
  );
}

/** Lists every edge type: the shipped core set plus the instance's own
 *  custom edge types. A stored registration under an identifier a later
 *  release ships is left out, since the shipped definition is the one that
 *  resolves. */
export function listEdgeTypes(): EdgeTypeSchema[] {
  return [
    ..._coreRegistry.values(),
    ...unshadowedEdgeTypeRegistrations(_customRegistry.values()),
  ];
}

/** Stored registrations whose identifiers are not held by shipped types. */
export function unshadowedEdgeTypeRegistrations(
  schemas: Iterable<EdgeTypeSchema>,
): EdgeTypeSchema[] {
  return [...schemas].filter((schema) => !isCoreEdgeType(schema.id));
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
