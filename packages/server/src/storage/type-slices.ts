/**
 * The type predicates of a listing, cut into pieces that an index on
 * `(type, <sort column>, id)` reads in order.
 *
 * A listing of a type and everything under it is a range on `type`, and an
 * index cannot order a range by anything but `type`. Each slice here is one
 * point (`type = ?`) or a range with nothing registered in it, and a listing
 * reads each slice in order and merges them (`SELECT ... UNION ALL SELECT ...
 * ORDER BY ... LIMIT`), so a page reads about the rows it answers. SQLite
 * stops pulling rows from every slice once the limit is met.
 *
 * The registry only decides where the cuts fall. The slices cover the whole
 * of the predicate by construction: every registered type under a subtree is
 * a point, and what lies between two points is a range of its own, so an item
 * whose type is not in the registry is still read, by a range that sorts its
 * rows. That keeps the answer right whatever the registry holds when the
 * statement runs.
 */

import {
  GLOBAL_TYPE_WILDCARD,
  declaredDescendantsOutsideNamespace,
  listTypes,
  subtreeWildcardRoot,
} from "@withmarfa/shared";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * One piece of the type space. A range is `from <= type < before`, or
 * `from < type < before` when `exclusiveFrom`; the bounds are compared as
 * UTF-8 bytes, as SQLite's binary collation does.
 */
export type TypeSlice =
  { point: string } | { from: string; exclusiveFrom: boolean; before: string };

/**
 * The most slices one statement carries. Every slice repeats the listing's
 * other conditions, and SQLite refuses a compound select past 500 terms;
 * beyond this a subtree is read as one range and sorted.
 */
export const MAX_TYPE_SLICES = 128;

/**
 * The most type patterns and sources one statement repeats across its slices,
 * counted as slices times the patterns a slice carries. Each is a bound
 * parameter, and SQLite refuses a statement past its parameter limit.
 */
export const MAX_REPEATED_TERMS = 4096;

/** What a listing's type predicates restrict. */
export interface TypeScope {
  /** The `?type=` read filter. */
  type?: string | undefined;
  /** The credential's grants. */
  allowed_types?: readonly string[] | undefined;
  /**
   * The patterns and sources the rest of the statement repeats in every
   * slice: the grants, the exclusions and the source filter.
   */
  repeatedTerms?: number | undefined;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Every type that names `root.` as a prefix. */
function underRoot(type: string, root: string): boolean {
  return type.startsWith(`${root}.`);
}

/**
 * The slices that together cover every type `scope` can admit, none
 * overlapping, or `undefined` when the scope restricts nothing or needs
 * more than {@link MAX_TYPE_SLICES} of them.
 *
 * A cover, not the predicate: a credential's exclusions still narrow each
 * slice, in the statement's own conditions.
 */
export function typeSlices(scope: TypeScope): TypeSlice[] | undefined {
  const cover = coverOf(scope);
  if (cover === undefined) return undefined;

  const roots = [...cover.roots].filter(
    (root) => ![...cover.roots].some((other) => underRoot(root, other)),
  );
  const points = new Set(
    [...cover.points].filter((type) => !roots.some((r) => underRoot(type, r))),
  );

  const slices: TypeSlice[] = [];
  for (const point of points) slices.push({ point });
  const registered = listTypes().map((schema) => schema.id);
  for (const root of roots) {
    const inside = [
      ...new Set(registered.filter((type) => underRoot(type, root))),
    ].sort(compareBytes);
    for (const point of inside) slices.push({ point });
    // `/` follows `.` in binary order, so `<root>/` bounds `<root>.*`.
    let from = `${root}.`;
    let exclusiveFrom = false;
    for (const point of [...inside, `${root}/`]) {
      if (compareBytes(from, point) < 0)
        slices.push({ from, exclusiveFrom, before: point });
      from = point;
      exclusiveFrom = true;
    }
  }
  const repeated = Math.max(1, scope.repeatedTerms ?? 0);
  return slices.length > 0 &&
    slices.length <= MAX_TYPE_SLICES &&
    slices.length * repeated <= MAX_REPEATED_TERMS
    ? slices
    : undefined;
}

/**
 * The points and subtree roots a scope names, before they are cut. A `type`
 * filter names its root, the types that declare their way under it, and every
 * name under the root; a credential's grants name what they say, by name only.
 */
function coverOf(
  scope: TypeScope,
): { points: Set<string>; roots: Set<string> } | undefined {
  const points = new Set<string>();
  const roots = new Set<string>();
  if (scope.type !== undefined && scope.type !== GLOBAL_TYPE_WILDCARD) {
    const root = subtreeWildcardRoot(scope.type) ?? scope.type;
    points.add(root);
    roots.add(root);
    for (const type of declaredDescendantsOutsideNamespace(root))
      points.add(type);
    return { points, roots };
  }
  const grants = scope.allowed_types;
  if (grants === undefined || grants.includes(GLOBAL_TYPE_WILDCARD))
    return undefined;
  for (const grant of grants) {
    if (grant === "") continue;
    const root = subtreeWildcardRoot(grant);
    if (root === null) {
      points.add(grant);
    } else {
      points.add(root);
      roots.add(root);
    }
  }
  return { points, roots };
}

/** A slice as a predicate on a type column. */
export function typeSliceSql(column: SQLWrapper, slice: TypeSlice): SQL {
  if ("point" in slice) return sql`${column} = ${slice.point}`;
  const lower = slice.exclusiveFrom
    ? sql`${column} > ${slice.from}`
    : sql`${column} >= ${slice.from}`;
  return sql`(${lower} AND ${column} < ${slice.before})`;
}
