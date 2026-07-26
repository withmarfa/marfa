// The one implementation of what a type pattern matches.
//
// Type patterns appear in four unrelated-looking places — credential
// `type_permissions`, OAuth scopes, webhook `type_filter`, and the storage
// layer's `allowed_types` filter — and they have to agree, or a credential is
// admitted by one gate and filtered out by the next. Everything that resolves
// a `.*` pattern goes through this module.

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
}

function escapeLikeLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function typePatternToSql(pattern: string): TypePatternSql {
  if (pattern === GLOBAL_TYPE_WILDCARD) {
    return { global: true, exact: null, descendantPattern: null };
  }
  const root = subtreeWildcardRoot(pattern);
  if (root === null) {
    return { global: false, exact: pattern, descendantPattern: null };
  }
  return {
    global: false,
    exact: root,
    descendantPattern: `${escapeLikeLiteral(root)}.%`,
  };
}
