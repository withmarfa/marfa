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
 * Confusable pair: this takes ONE pattern; `matchesTypePattern` in
 * validation.ts takes a LIST. The names are near-reversals of each other and
 * both read (type, pattern-or-patterns), so the two are easy to swap while
 * refactoring and the swap does not look wrong on the page.
 *
 * What makes it worth a warning rather than a naming tidy-up is what the
 * answer is used for: both return a plausible boolean, and the callers are
 * permission checks. A call that reaches the wrong one does not fail, it
 * quietly answers a different question about who may read what.
 */

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
 * bucket the platform set registers into — and does resolve.
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

/**
 * Whether a type answers one entry of a `?type=` READ FILTER, for a caller
 * holding a type in hand rather than a query.
 *
 * The JavaScript twin of {@link typeSubtreeToSql}, written to the same three
 * clauses so a streamed answer and a queried one cannot disagree about the
 * same filter: the global wildcard, the subtree root and everything under
 * its name, and the types that declare their way there from outside it. The
 * SSE stream is the caller — it filters events in JavaScript because there is
 * no query to hang a predicate on — and before this existed it resolved the
 * declared clause alone, so `*` and `core.media.*` matched nothing at all
 * while the same spellings on `/items` matched everything and a subtree.
 *
 * The declared clause is asked of the one type in hand rather than resolved
 * into a set. `declaredDescendantsOutsideNamespace`, which the SQL side uses,
 * is *defined* as the types whose `isSubtypeOf` reaches the root, so a
 * membership test against that list and this call answer the same question —
 * but the list costs a pass over the space's whole vocabulary and this costs
 * a walk up one chain. A query resolves the filter once and wants the set; a
 * stream resolves it per event and wants the predicate.
 *
 * `spaceId` reads exactly as it does for {@link typeSubtreeToSql}:
 * `undefined` means the caller resolves names only and the declared
 * clause is skipped, `null` is the real null-space scope a platform
 * self-host registers into, and a string is that space.
 *
 * Ordered cheapest first, and the ordering is load-bearing rather than
 * cosmetic. Both name clauses are string comparisons, so a filter naming a
 * namespace answers for everything inside it without consulting the registry
 * at all; only a type named outside the filter's namespace pays the walk, and
 * only that type can raise the unresolvable-chain error the walk throws.
 *
 * Deliberately NOT the rule for permission patterns, which resolve names only
 * — see `typePatternToSql` for why expanding a grant through declared
 * parentage puts the list query and the single-item gate into disagreement.
 */
export function typeAnswersSubtreeFilter(
  type: string,
  filter: string,
  spaceId?: string | null,
): boolean {
  if (filter === GLOBAL_TYPE_WILDCARD) return true;
  const root = subtreeWildcardRoot(filter) ?? filter;
  if (type === root) return true;
  if (type.startsWith(`${root}.`)) return true;
  // The same three-way reading of `spaceId` that `declaredExtras` gives
  // the SQL side, and it has to be stated rather than inherited:
  // `resolveSchema` treats `undefined` and `null` alike, so without this
  // line a caller omitting the argument would resolve declared parentage
  // where `typeSubtreeToSql` resolves none — the two disagreeing about
  // the same filter, which is the one thing this function exists to
  // prevent. `undefined` means names only; `null` is a real scope.
  if (spaceId === undefined) return false;
  return isSubtypeOf(type, root, spaceId);
}

// ---------------------------------------------------------------------------
// Type filters: a grant and the exclusions that carve into it
// ---------------------------------------------------------------------------

/**
 * What a credential may read, as a list query can express it.
 *
 * `allowed: undefined` means no credential at all — bootstrap and the
 * anonymous reads, and nothing else. Every authenticated caller arrives with a
 * real list, because its permission map is the whole of what it may reach. An
 * empty array is the opposite: nothing is visible. `excluded` subtracts from
 * `allowed` under the ranking `resolveTypePermission` uses, which is why the
 * two travel together: a caller that took the permitted list alone would fail
 * open, and that is the defect this shape exists to make unrepresentable
 * rather than to guard against.
 */
export interface TypeFilter {
  allowed: string[] | undefined;
  excluded: string[];
}

/**
 * A granted pattern and the exclusions that outrank it.
 *
 * `minus` is not "every exclusion". A permission map is resolved by
 * specificity — an exact key beats any wildcard, a longer subtree root beats a
 * shorter one, the global wildcard is the last resort — so an exclusion only
 * subtracts from a grant *less* specific than itself. `{"user.secret":
 * "read", "user.*": "none"}` grants `user.secret`, because the exact key wins,
 * and a compiler that subtracted every exclusion from every grant would get
 * that backwards. Ranking once here is what keeps six SQL compilers and one
 * JavaScript predicate from each having their own opinion about it.
 */
export interface TypeFilterTerm {
  pattern: string;
  minus: string[];
}

/**
 * Specificity, in `resolveTypePermission`'s order. An exact identifier is
 * unbounded rather than merely long: that function returns on an exact key
 * before it looks at any wildcard, so no subtree root can outrank one however
 * deep it is.
 */
function patternRank(pattern: string): number {
  if (pattern === GLOBAL_TYPE_WILDCARD) return -1;
  const root = subtreeWildcardRoot(pattern);
  if (root === null) return Number.POSITIVE_INFINITY;
  return root.length;
}

/**
 * Whether an exclusion can remove anything from what a grant admits.
 *
 * Probing with the exclusion's own root rather than the pattern string is what
 * makes a subtree exclusion answer for its whole subtree: if `user.a` is
 * inside `user.*` then so is everything under it.
 */
function exclusionReachesInto(grant: string, exclusion: string): boolean {
  const root = subtreeWildcardRoot(exclusion);
  return typeMatchesPattern(root ?? exclusion, grant);
}

/**
 * Decompose a filter into terms a query can compile independently.
 *
 * Each granted pattern keeps only the exclusions that both outrank it and
 * reach into it, so a compiler emits `match(pattern) AND NOT (match(minus) OR
 * ...)` per term and `or`s the terms together. With no exclusions every
 * `minus` is empty and the result is exactly the disjunction these compilers
 * have always emitted.
 */
export function typeFilterTerms(
  allowed: string[],
  excluded: string[],
): TypeFilterTerm[] {
  return allowed.map((pattern) => {
    const rank = patternRank(pattern);
    return {
      pattern,
      minus: excluded.filter(
        (exclusion) =>
          patternRank(exclusion) > rank &&
          exclusionReachesInto(pattern, exclusion),
      ),
    };
  });
}

/**
 * The same decision as the SQL compilers, for callers that hold a type in hand
 * rather than a query — the SSE stream, which filters events in JavaScript
 * because there is no query to attach a predicate to.
 *
 * Written over {@link typeFilterTerms} rather than beside it so the ranking
 * cannot drift between the streamed answer and the queried one for the same
 * grant.
 */
export function matchesTypeFilter(type: string, filter: TypeFilter): boolean {
  if (filter.allowed === undefined) return true;
  return typeFilterTerms(filter.allowed, filter.excluded).some(
    ({ pattern, minus }) =>
      typeMatchesPattern(type, pattern) &&
      !minus.some((exclusion) => typeMatchesPattern(type, exclusion)),
  );
}
