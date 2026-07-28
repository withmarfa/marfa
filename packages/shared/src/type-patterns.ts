// The one implementation of what a type pattern matches.
//
// Type patterns appear in four unrelated-looking places — credential
// `type_permissions`, OAuth scopes, webhook `type_filter`, and the storage
// layer's `allowed_types` filter — and they have to agree, or a credential is
// admitted by one gate and filtered out by the next. Everything that resolves
// a `.*` pattern goes through this module.
//
// A subtree has two roots, not one. The dotted identifier is a namespace, and
// the registry's `parent` field is a declared lineage; a type may sit in one
// without sitting in the other, because registration validates the parent chain
// and never requires the child's name to start with the parent's. So a subtree
// resolves to the union: everything under the name, plus everything that
// declares its way there. Taking only the first is the defect this module now
// closes — a declared child named elsewhere was absent from every read and
// every permission check, silently. Taking only the second would drop the
// namespace, which is load-bearing in its own right (nothing declares a parent
// of `google`, yet `google.*` plainly means the Google types).
//
// Resolving the declared half needs the registry, and the registry is
// tenant-scoped because custom types are. Hence the optional `tenantId` on the
// helpers below: omit it and they behave exactly as before, which keeps every
// pure caller (webhook filters, scope parsing) working on names alone.

import {
  declaredDescendantsOutsideNamespace,
  isSubtypeOf,
} from "./type-registry.js";

/** Matches every type, including the reserved namespaces. */
export const GLOBAL_TYPE_WILDCARD = "*";

/**
 * The root a subtree wildcard covers: `core.media.*` → `core.media`. Returns
 * null for the global wildcard and for exact identifiers.
 */
export function subtreeWildcardRoot(pattern: string): string | null {
  if (pattern === GLOBAL_TYPE_WILDCARD) return null;
  if (!pattern.endsWith(".*")) return null;
  const root = pattern.slice(0, -2);
  return root.length > 0 ? root : null;
}

/**
 * Whether a type identifier is covered by a single pattern.
 *
 * A subtree wildcard is **parent-inclusive**: `core.media.*` covers
 * `core.media` as well as `core.media.book`. That is how the pattern reads to
 * anyone granting it — "media and everything under it" — and it is what the
 * OAuth consent screen has always expanded it to, so the alternative would
 * mean a token whose granted scope list and whose permission map disagree
 * about the parent type.
 */
export function typeMatchesPattern(
  type: string,
  pattern: string,
  tenantId?: string | null,
): boolean {
  if (pattern === GLOBAL_TYPE_WILDCARD) return true;
  if (pattern === type) return true;
  const root = subtreeWildcardRoot(pattern);
  if (root === null) return false;
  if (type === root || type.startsWith(`${root}.`)) return true;
  // The declared half of the subtree. Checked second because the name answers
  // it for almost every type, and only reachable when a tenant scope was
  // supplied — a caller matching names alone gets exactly the old behavior.
  if (tenantId === undefined) return false;
  return isSubtypeOf(type, root, tenantId);
}

/** Whether any pattern in the list covers the type. */
export function typeMatchesAnyPattern(
  type: string,
  patterns: readonly string[],
  tenantId?: string | null,
): boolean {
  for (const pattern of patterns) {
    if (typeMatchesPattern(type, pattern, tenantId)) return true;
  }
  return false;
}

/**
 * Splits a pattern into the two clauses a SQL predicate needs: an exact
 * identifier to compare, and an escaped LIKE pattern for descendants.
 * Keeping the decomposition here is what stops each dialect's query builder from
 * re-deriving (and re-getting-wrong) the parent-inclusion rule.
 *
 * - `*`               → `{ global: true }`
 * - `core.media.*`    → `{ exact: "core.media", descendantPattern: "core.media.%" }`
 * - `core.note`       → `{ exact: "core.note" }`
 */
export interface TypePatternSql {
  /** The pattern matches every type; emit no predicate at all. */
  global: boolean;
  /** Identifier to compare with equality, when the pattern has one. */
  exact: string | null;
  /** Descendant matcher for `LIKE ... ESCAPE '\\'`. */
  descendantPattern: string | null;
  /**
   * Declared descendants the name-based clauses above cannot reach, for an
   * `IN (...)` term. Empty unless a tenant scope was supplied, so a caller that
   * resolves names alone emits exactly the predicate it always did.
   */
  extraTypes: string[];
}

/**
 * `undefined` means the caller resolves names only, so the registry is never
 * consulted and the result is empty. `null` is a real scope — the null-tenant
 * bucket a single-tenant self-host registers into — and does resolve.
 */
function declaredExtras(root: string, tenantId?: string | null): string[] {
  if (tenantId === undefined) return [];
  return declaredDescendantsOutsideNamespace(root, tenantId);
}

function escapeLikeLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function typePatternToSql(
  pattern: string,
  tenantId?: string | null,
): TypePatternSql {
  if (pattern === GLOBAL_TYPE_WILDCARD) {
    return {
      global: true,
      exact: null,
      descendantPattern: null,
      extraTypes: [],
    };
  }
  const root = subtreeWildcardRoot(pattern);
  if (root === null) {
    // A bare identifier is an exact grant here; widening it to a subtree would
    // hand a narrowly-scoped credential everything under the type.
    return {
      global: false,
      exact: pattern,
      descendantPattern: null,
      extraTypes: [],
    };
  }
  return {
    global: false,
    exact: root,
    descendantPattern: `${escapeLikeLiteral(root)}.%`,
    extraTypes: declaredExtras(root, tenantId),
  };
}

/**
 * The SQL decomposition for a *read filter* (`?type=`), where a bare
 * identifier already selects its subtree: `core.entity` has always returned
 * `core.entity.person` too. Both spellings therefore produce both clauses.
 *
 * Deliberately separate from `typePatternToSql`, which serves permission
 * grants — there a bare `core.note` is an exact grant and must NOT reach
 * descendants, or a credential scoped to one type would silently read the
 * whole subtree. Same input strings, opposite defaults, so they cannot share
 * one function.
 *
 * - `*`               → `{ global: true }`
 * - `core.entity`     → `{ exact: "core.entity", descendantPattern: "core.entity.%" }`
 * - `core.entity.*`   → identical to the line above
 */
export function typeSubtreeToSql(
  type: string,
  tenantId?: string | null,
): TypePatternSql {
  if (type === GLOBAL_TYPE_WILDCARD) {
    return {
      global: true,
      exact: null,
      descendantPattern: null,
      extraTypes: [],
    };
  }
  const root = subtreeWildcardRoot(type) ?? type;
  return {
    global: false,
    exact: root,
    descendantPattern: `${escapeLikeLiteral(root)}.%`,
    extraTypes: declaredExtras(root, tenantId),
  };
}
