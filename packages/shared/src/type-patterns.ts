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
// everything that declares its way there. Resolving names alone would leave a
// declared child named elsewhere missing from a query against its own parent,
// with no error. Resolving declarations alone would break the other half,
// since nothing declares a parent of `acme` yet `acme.*` plainly means Acme's
// types.
//
// PERMISSION PATTERNS resolve names only, deliberately. A permission map is
// ranked by specificity (`patternRank`), and there is no defensible way to rank
// a name match against a declared one. The concrete failure was a map of
// `{"user.*": "none", "core.note.*": "read"}` against a type named under
// `user` that declares `core.note` as its parent: the deny won at the
// single-item gate, which resolves names, while an expanded grant won in the
// list query, so a row the credential was denied came back in a listing and
// answered as missing by id. Names are also what the grant was written
// against: whoever wrote `user.*: none` meant the namespace.
//
// The SQL forms of both rules live in the server's `storage/filter-sql.ts`.
//
// Resolving the declared half needs the registry, which holds the
// instance's own registrations beside the shipped set.

import { isSubtypeOf } from "./type-registry.js";

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
 * Whether a type answers one entry of a `?type=` READ FILTER, for a caller
 * holding a type in hand rather than a query.
 *
 * The JavaScript twin of the server's `typeSubtreeSql`, written to the same three
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
 * but the list costs a pass over the whole vocabulary and this costs
 * a walk up one chain. A query resolves the filter once and wants the set; a
 * stream resolves it per event and wants the predicate.
 *
 * Ordered cheapest first, and the ordering is load-bearing rather than
 * cosmetic. Both name clauses are string comparisons, so a filter naming a
 * namespace answers for everything inside it without consulting the registry
 * at all; only a type named outside the filter's namespace pays the walk, and
 * only that type can raise the unresolvable-chain error the walk throws.
 *
 * Deliberately NOT the rule for permission patterns, which resolve names only;
 * the header of this file says why.
 */
export function typeAnswersSubtreeFilter(
  type: string,
  filter: string,
): boolean {
  if (filter === GLOBAL_TYPE_WILDCARD) return true;
  const root = subtreeWildcardRoot(filter) ?? filter;
  if (type === root) return true;
  if (type.startsWith(`${root}.`)) return true;
  return isSubtypeOf(type, root);
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
 * `allowed` under `patternRank`, the ranking `resolveTypePermission` uses, which is why the
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
 * that backwards. Ranking once here is what keeps the SQL compiler and the
 * JavaScript predicate from each having their own opinion about it.
 */
interface TypeFilterTerm {
  pattern: string;
  minus: string[];
}

/**
 * How specific a map entry is: the global wildcard last, a subtree wildcard by
 * the length of its root, an exact identifier above every wildcard however
 * deep. Two entries that both cover one type never tie: two roots of one
 * length that both prefix a type are the same root.
 *
 * The one ranking. `typeFilterTerms` (and through it every SQL compiler and
 * `matchesTypeFilter`) and `resolveTypePermission` all rank with it.
 */
export function patternRank(pattern: string): number {
  if (pattern === GLOBAL_TYPE_WILDCARD) return -1;
  const root = subtreeWildcardRoot(pattern);
  if (root === null) return Number.POSITIVE_INFINITY;
  return root.length;
}

/**
 * The entry of a permission map that decides a type: the most specific of the
 * patterns that cover it, or `undefined` when none does.
 */
export function decidingPattern(
  type: string,
  patterns: Iterable<string>,
): string | undefined {
  let deciding: string | undefined;
  let rank = Number.NEGATIVE_INFINITY;
  for (const pattern of patterns) {
    if (!typeMatchesPattern(type, pattern)) continue;
    const candidate = patternRank(pattern);
    if (candidate > rank) {
      deciding = pattern;
      rank = candidate;
    }
  }
  return deciding;
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
 * reach into it, so a caller tests `match(pattern) AND NOT (match(minus) OR
 * ...)` per term and `or`s the terms together. With no exclusions every
 * `minus` is empty and the result is the plain disjunction of the grants.
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
 * The same decision as the SQL compiler, for callers that hold a type in hand
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
