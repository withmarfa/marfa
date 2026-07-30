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
// and never requires the child's name to start with the parent's.
//
// The `?type=` READ FILTER resolves both: everything under the name, plus
// everything that declares its way there. Resolving names alone is the defect
// this closes — a declared child named elsewhere was missing from a query
// against its own parent, with no error. Resolving declarations alone would
// break the other half, since nothing declares a parent of `google` yet
// `google.*` plainly means the Google types.
//
// PERMISSION PATTERNS resolve names only. That asymmetry is deliberate and is
// explained at `typePatternToSql`: a permission map is ranked by longest-prefix
// precedence, and there is no defensible way to rank a name match against a
// declared one, so expanding grants put the list query and the single-item gate
// into disagreement in the fail-open direction.
//
// Resolving the declared half needs the registry, and the registry is
// space-scoped because custom types are. Hence the optional `spaceId` on
// `typeSubtreeToSql`: omit it and it behaves exactly as before.

import { declaredDescendantsOutsideNamespace } from "./type-registry.js";

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
export function typeMatchesPattern(type: string, pattern: string): boolean {
  if (pattern === GLOBAL_TYPE_WILDCARD) return true;
  if (pattern === type) return true;
  const root = subtreeWildcardRoot(pattern);
  if (root === null) return false;
  return type === root || type.startsWith(`${root}.`);
}

/** Whether any pattern in the list covers the type. */
export function typeMatchesAnyPattern(
  type: string,
  patterns: readonly string[],
): boolean {
  for (const pattern of patterns) {
    if (typeMatchesPattern(type, pattern)) return true;
  }
  return false;
}

/**
 * Splits a pattern into the two clauses a SQL predicate needs: an exact
 * identifier to compare, and an escaped LIKE pattern for descendants.
 * Keeping the decomposition here is what stops each dialect's query builder from
 * re-deriving (and re-getting-wrong) the parent-inclusion rule.
 *
 * **Permission patterns resolve by name only, deliberately.** Only the read
 * filter below consults declared parentage. Expanding a grant through the
 * registry looked symmetrical and is not: a permission map is resolved by
 * longest-prefix precedence, and the two hierarchies give no way to rank a
 * name match against a declared one. The concrete failure was a map of
 * `{"user.*": "none", "core.note.*": "read"}` against a type named under
 * `user` that declares `core.note` as its parent — the deny won at the
 * single-item gate, which resolves names, while the expanded grant won in the
 * list query, so a row the credential was explicitly denied came back in a
 * listing and 403'd when fetched by id. Names are also what the grant was
 * written against: whoever wrote `user.*: none` meant the namespace.
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
   * `IN (...)` term. Empty unless a space scope was supplied, so a caller that
   * resolves names alone emits exactly the predicate it always did.
   */
  extraTypes: string[];
}

/**
 * `undefined` means the caller resolves names only, so the registry is never
 * consulted and the result is empty. `null` is a real scope — the null-space
 * bucket a single-space self-host registers into — and does resolve.
 */
function declaredExtras(root: string, spaceId?: string | null): string[] {
  if (spaceId === undefined) return [];
  return declaredDescendantsOutsideNamespace(root, spaceId);
}

function escapeLikeLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function typePatternToSql(pattern: string): TypePatternSql {
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
    extraTypes: [],
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
  spaceId?: string | null,
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
    extraTypes: declaredExtras(root, spaceId),
  };
}
