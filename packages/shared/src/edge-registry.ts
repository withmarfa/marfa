import { ALL_EDGE_TYPES } from "@withmarfa/types";
import type {
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
} from "@withmarfa/types";
import { getTypeSchema, isSubtypeOf } from "./type-registry.js";

// Re-export types so consumers of @withmarfa/shared can reach them without
// depending on @withmarfa/types directly.
export type { EdgeCardinality, EdgeCascade, EdgeTypeSchema };
export { ALL_EDGE_TYPES };

// Core edge types are global — shipped with @withmarfa/types and shared by
// every tenant. This map is read-only after construction.
const _coreRegistry = new Map<string, EdgeTypeSchema>(
  ALL_EDGE_TYPES.map((schema) => [schema.id, schema]),
);

/**
 * Custom edge types are tenant-scoped. The outer key is the owning tenant's
 * id; each tenant gets its own inner id→schema map. A custom edge type
 * registered by tenant A is therefore invisible to tenant B's lookups —
 * the isolation that keeps one tenant's relationship vocabulary out of
 * another's. The sentinel `NULL_TENANT` key holds custom edge types with no
 * tenant (single-tenant self-hosts, platform-registered types) so the
 * keys-mode flow is unaffected.
 */
const _customByTenant = new Map<string, Map<string, EdgeTypeSchema>>();

// Sentinel for custom edge types with no owning tenant — single-tenant
// self-hosts and platform-registered types. An empty string can't collide
// with a real tenant id (ids are non-empty), so it's a safe bucket key.
const NULL_TENANT = "";

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? NULL_TENANT;
}

/**
 * The core edge-type registry — the eight global edge types by identifier.
 * Custom (tenant-scoped) edge types are NOT exposed here; consumers that need
 * the full set for a tenant call `listEdgeTypes(tenantId)`. The OAuth scope
 * allow-list reads this for the static core-scope enumeration.
 */
export const EDGE_TYPE_REGISTRY: ReadonlyMap<string, EdgeTypeSchema> =
  _coreRegistry;

/**
 * Resolves an edge-type schema for a given tenant. Core edge types resolve
 * globally; custom edge types resolve only within their owning tenant. A
 * lookup with no `tenantId` sees core types plus the null-tenant bucket
 * (single-tenant self-hosts), never another tenant's custom types.
 */
export function getEdgeTypeSchema(
  edgeTypeId: string,
  tenantId?: string | null,
): EdgeTypeSchema | undefined {
  const core = _coreRegistry.get(edgeTypeId);
  if (core) return core;
  return _customByTenant.get(tenantKey(tenantId))?.get(edgeTypeId);
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
 * Registers a custom edge-type schema into the tenant's overlay. Core edge
 * types are never registered here (they live in the global map); callers
 * filter them out before calling. `tenantId` is the owning tenant — omit it
 * only for the null-tenant bucket (single-tenant self-host / platform).
 */
export function registerEdgeTypeSchema(
  schema: EdgeTypeSchema,
  tenantId?: string | null,
): void {
  const key = tenantKey(tenantId);
  let bucket = _customByTenant.get(key);
  if (!bucket) {
    bucket = new Map<string, EdgeTypeSchema>();
    _customByTenant.set(key, bucket);
  }
  bucket.set(schema.id, schema);
}

/** Removes a custom edge-type schema from the tenant's overlay. */
export function unregisterEdgeTypeSchema(
  id: string,
  tenantId?: string | null,
): void {
  _customByTenant.get(tenantKey(tenantId))?.delete(id);
}

/**
 * Lists every edge type visible to a tenant: the global core set plus that
 * tenant's own custom edge types. With no `tenantId`, returns core plus the
 * null-tenant bucket — never another tenant's custom types.
 */
export function listEdgeTypes(tenantId?: string | null): EdgeTypeSchema[] {
  const custom = _customByTenant.get(tenantKey(tenantId));
  if (!custom) return [..._coreRegistry.values()];
  return [..._coreRegistry.values(), ...custom.values()];
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
  tenantId?: string | null,
): boolean {
  if (constraints.length === 0) return true;
  if (constraints.includes("*")) return true;
  // Unknown item types can't be reasoned about — fail closed. Resolve within
  // the tenant so a custom item type used as an edge endpoint is recognized
  // (core/system types resolve regardless of tenant).
  if (!getTypeSchema(typeId, tenantId)) return false;
  for (const allowed of constraints) {
    if (allowed === "*") return true;
    if (isSubtypeOf(typeId, allowed, tenantId)) return true;
  }
  return false;
}
