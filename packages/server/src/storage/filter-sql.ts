/**
 * The one SQL compiler for what a read selects: the advanced query language,
 * the credential's type map, the `?type=` read filter, the `system.*`
 * default and the `source_filter` lever. Every store builds its statement
 * from these as Drizzle `SQL`, so every value is a bound parameter and no
 * statement is ever split on `?`.
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  declaredDescendantsOutsideNamespace,
  subtreeWildcardRoot,
  typeFilterTerms,
  type TypeFilter,
} from "@withmarfa/shared";
import { normalizeTimeBound } from "./interface.js";
import type {
  FilterExpression,
  FilterCondition,
  ComparisonOp,
} from "@withmarfa/shared";

// ---------------------------------------------------------------------------
// Types: the permission map, the read filter and the system default
// ---------------------------------------------------------------------------

/**
 * `/` immediately follows `.` in binary order, so these bounds cover
 * exactly the `<root>.` prefix. A range can use the BINARY type index;
 * default case-insensitive LIKE cannot.
 */
function subtreeBounds(root: string): { from: string; before: string } {
  return { from: `${root}.`, before: `${root}/` };
}

/** A type and everything named under it, compared by exact characters. */
function namedSubtreeSql(column: SQLWrapper, root: string): SQL {
  const { from, before } = subtreeBounds(root);
  return sql`(${column} = ${root} OR (${column} >= ${from} AND ${column} < ${before}))`;
}

/**
 * One permission pattern as a predicate on a type column.
 *
 * By name only, never by declared parent: `type-patterns.ts` says why. A bare
 * identifier is an exact grant; widening it to a subtree would hand a
 * credential scoped to one type everything under it. Only the empty string
 * reaches `1=0`, and `resolveTypePermission` cannot honor that as a grant or
 * as an exclusion either, so `1=0` matches the point check in both positions.
 */
function permissionPatternSql(column: SQLWrapper, pattern: string): SQL {
  if (pattern === GLOBAL_TYPE_WILDCARD) return sql`1=1`;
  const root = subtreeWildcardRoot(pattern);
  if (root !== null) return namedSubtreeSql(column, root);
  if (pattern === "") return sql`1=0`;
  return sql`${column} = ${pattern}`;
}

/**
 * The credential's type map as a predicate on a type column: the one
 * compiler every door that reads with SQL uses, and the twin of
 * `matchesTypeFilter`, which compiles the same `typeFilterTerms`.
 *
 * `allowed: undefined` (no credential to bound the read) and a global grant
 * that nothing carves into both restrict nothing, and answer `undefined`, so
 * a caller adds the result only when it is present. An empty `allowed` is a
 * credential that may read no type, and answers `1=0` rather than nothing.
 */
export function typeFilterSql(
  column: SQLWrapper,
  filter: TypeFilter,
): SQL | undefined {
  if (filter.allowed === undefined) return undefined;
  const terms = typeFilterTerms(filter.allowed, filter.excluded);
  if (
    terms.some(
      ({ pattern, minus }) =>
        pattern === GLOBAL_TYPE_WILDCARD && minus.length === 0,
    )
  )
    return undefined;
  if (terms.length === 0) return sql`1=0`;
  const clauses = terms.map(({ pattern, minus }) => {
    const granted = permissionPatternSql(column, pattern);
    if (minus.length === 0) return granted;
    // `typeFilterTerms` has already dropped the exclusions this grant
    // outranks, so everything left carves into it.
    const carved = minus.map((m) => permissionPatternSql(column, m));
    return sql`(${granted} AND NOT (${sql.join(carved, sql` OR `)}))`;
  });
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/**
 * A `?type=` read filter as a predicate on a type column: the type, every
 * type named under it, and every type that declares its way under it from
 * outside its name. `core.entity` and `core.entity.*` read the same, and `*`
 * restricts nothing. The JavaScript twin is `typeAnswersSubtreeFilter`.
 *
 * Deliberately not the permission compiler above: the same strings, opposite
 * defaults. Here a bare identifier selects its subtree; in a grant it is
 * exact.
 */
export function typeSubtreeSql(
  column: SQLWrapper,
  type: string,
): SQL | undefined {
  if (type === GLOBAL_TYPE_WILDCARD) return undefined;
  const root = subtreeWildcardRoot(type) ?? type;
  const named = namedSubtreeSql(column, root);
  const declared = declaredDescendantsOutsideNamespace(root);
  if (declared.length === 0) return named;
  return sql`(${named} OR ${column} IN (${sql.join(
    declared.map((t) => sql`${t}`),
    sql`, `,
  )}))`;
}

/**
 * The default that keeps platform rows out of an ordinary read, decided by
 * `excludesSystemTypes`. A name test on the column, so the route's opt-in and
 * this exclusion read the same rows.
 */
export function notSystemTypeSql(column: SQLWrapper): SQL {
  return sql`${column} NOT LIKE 'system.%'`;
}

/**
 * The clause a `backref` term adds so it counts only edges whose source the
 * caller may read, as every door that serves an edge does; empty for no
 * credential. The source item must exist even when the map reads every type.
 */
function readableSourceSql(sources: TypeFilter | undefined): SQL {
  if (sources?.allowed === undefined) return sql``;
  const readable = typeFilterSql(sql`s.type`, sources) ?? sql`1=1`;
  return sql`AND EXISTS (SELECT 1 FROM items s WHERE s.id = e.source_id AND ${readable})`;
}

/**
 * Escape LIKE pattern characters so they are treated as literals.
 *
 * Only half the job: the escape character has to be declared too. SQLite
 * has no default, so an unaccompanied `\_` is a literal backslash followed
 * by the single-character wildcard — a `contains` filter for `web_gallery`
 * silently matches nothing. Every LIKE built from this must carry
 * `ESCAPE '\\'`.
 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * The text operators are case-insensitive: SQLite's LIKE is
 * case-insensitive over ASCII, and the folder query's index is collated
 * NOCASE to match. That case-insensitivity is ASCII-only, an engine
 * limitation documented in the query reference rather than papered over
 * here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Table reference with the columns we need for condition generation. */
interface ItemsTableRef {
  id: unknown;
  state: unknown;
  type: unknown;
  source: unknown;
  source_id: unknown;
  occurred_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  tier: unknown;
  version: unknown;
  properties: unknown;
}

// ---------------------------------------------------------------------------
// System field column mapping
// ---------------------------------------------------------------------------

function getSystemColumn(table: ItemsTableRef, column: string): unknown {
  const map: Record<string, unknown> = {
    state: table.state,
    type: table.type,
    source: table.source,
    source_id: table.source_id,
    occurred_at: table.occurred_at,
    created_at: table.created_at,
    updated_at: table.updated_at,
    tier: table.tier,
    version: table.version,
    id: table.id,
  };
  return map[column];
}

// ---------------------------------------------------------------------------
// The filter expression
// ---------------------------------------------------------------------------

function conditionToSql(
  condition: FilterCondition,
  table: ItemsTableRef,
  sources: TypeFilter | undefined,
): SQL {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    const col = getSystemColumn(table, field.column);
    return systemFieldSql(
      col,
      op,
      systemComparisonValue(field.column, op, value),
    );
  }

  if (field.kind === "property") {
    return propertyFieldSql(table.properties, field.path, op, value);
  }

  if (field.kind === "edge") {
    return edgeFieldSql(
      table.id,
      field.edge_type,
      field.direction,
      op,
      value,
      sources,
    );
  }

  // tags
  return tagsFieldSql(table.id, op, value);
}

/**
 * Edge-membership filter. Direction = "outbound" → item is the source of an
 * edge of the given type pointing to `value` (or any edge with exists op).
 * Direction = "backref" → item is the target of such an edge.
 */
function edgeFieldSql(
  idCol: unknown,
  edgeType: string,
  direction: "outbound" | "backref",
  op: ComparisonOp,
  value: unknown,
  sources: TypeFilter | undefined,
): SQL {
  if (direction === "outbound") {
    switch (op) {
      case "eq":
        return sql`EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol}
            AND e.edge_type = ${edgeType}
            AND e.target_id = ${value}
        )`;
      case "neq":
        return sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol}
            AND e.edge_type = ${edgeType}
            AND e.target_id = ${value}
        )`;
      case "exists":
        return sql`EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol} AND e.edge_type = ${edgeType}
        )`;
      case "not_exists":
        return sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol} AND e.edge_type = ${edgeType}
        )`;
      default:
        throw new Error(`Unsupported operator "${op}" for edge reference`);
    }
  }
  // backref: an edge's readability is its source's, which is the far end here.
  const readable = readableSourceSql(sources);
  switch (op) {
    case "eq":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value} ${readable}
      )`;
    case "neq":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value} ${readable}
      )`;
    case "exists":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType} ${readable}
      )`;
    case "not_exists":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType} ${readable}
      )`;
    default:
      throw new Error(`Unsupported operator "${op}" for edge reference`);
  }
}

function systemComparisonValue(
  column: string,
  op: ComparisonOp,
  value: unknown,
): unknown {
  if (
    !["created_at", "updated_at", "occurred_at"].includes(column) ||
    !["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)
  )
    return value;
  if (typeof value !== "string") {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${column}: expected a timestamp`,
      { field: column, value },
    );
  }
  return normalizeTimeBound(value, column);
}

function systemFieldSql(col: unknown, op: ComparisonOp, value: unknown): SQL {
  switch (op) {
    case "eq":
      return sql`${col} = ${value}`;
    case "neq":
      return sql`${col} != ${value}`;
    case "gt":
      return sql`${col} > ${value}`;
    case "gte":
      return sql`${col} >= ${value}`;
    case "lt":
      return sql`${col} < ${value}`;
    case "lte":
      return sql`${col} <= ${value}`;
    case "contains":
      return sql`${col} LIKE ${"%" + escapeLike(String(value)) + "%"} ESCAPE '\\'`;
    case "starts_with":
      return sql`${col} LIKE ${escapeLike(String(value)) + "%"} ESCAPE '\\'`;
    default:
      throw new Error(`Unsupported operator "${op}" for system field`);
  }
}

function propertyFieldSql(
  propertiesCol: unknown,
  path: string,
  op: ComparisonOp,
  value: unknown,
): SQL {
  const jsonPath = `$.${path}`;
  const isNumeric = typeof value === "number";

  // json_extract reads the JSONB blob directly.
  const extract = sql`json_extract(${propertiesCol}, ${jsonPath})`;

  // Only JSON numbers take the API's double interpretation; casting text or
  // containers would invent numeric equality matches such as an object = 0.
  const numericEqualityExtract = sql`CASE WHEN json_type(${propertiesCol}, ${jsonPath}) IN ('integer', 'real') THEN CAST(${extract} AS REAL) ELSE ${extract} END`;

  // Numeric extraction for comparison operators
  const numericExtract = sql`CAST(json_extract(${propertiesCol}, ${jsonPath}) AS REAL)`;

  switch (op) {
    case "eq":
      return isNumeric
        ? sql`${numericEqualityExtract} = ${value}`
        : sql`${extract} = ${value}`;
    case "neq":
      return isNumeric
        ? sql`${numericEqualityExtract} != ${value}`
        : sql`${extract} != ${value}`;
    case "gt":
      return isNumeric
        ? sql`${numericExtract} > ${value}`
        : sql`${extract} > ${value}`;
    case "gte":
      return isNumeric
        ? sql`${numericExtract} >= ${value}`
        : sql`${extract} >= ${value}`;
    case "lt":
      return isNumeric
        ? sql`${numericExtract} < ${value}`
        : sql`${extract} < ${value}`;
    case "lte":
      return isNumeric
        ? sql`${numericExtract} <= ${value}`
        : sql`${extract} <= ${value}`;
    case "contains":
      return sql`${extract} LIKE ${"%" + escapeLike(String(value)) + "%"} ESCAPE '\\'`;
    case "starts_with":
      return sql`${extract} LIKE ${escapeLike(String(value)) + "%"} ESCAPE '\\'`;
    case "exists":
      return sql`${extract} IS NOT NULL`;
    case "not_exists":
      return sql`${extract} IS NULL`;
    default:
      throw new Error(
        `Unsupported operator "${String(op)}" for property field`,
      );
  }
}

function tagsFieldSql(idCol: unknown, op: ComparisonOp, value: unknown): SQL {
  if (op === "contains") {
    return sql`EXISTS (
      SELECT 1 FROM metadata m, json_each(m.tags) je
      WHERE m.item_id = ${idCol} AND je.value = ${value}
    )`;
  }

  if (op === "exists") {
    return sql`EXISTS (
      SELECT 1 FROM metadata m, json_each(m.tags) je
      WHERE m.item_id = ${idCol}
    )`;
  }

  if (op === "not_exists") {
    return sql`NOT EXISTS (
      SELECT 1 FROM metadata m, json_each(m.tags) je
      WHERE m.item_id = ${idCol}
    )`;
  }

  throw new Error(`Unsupported operator "${op}" for tags`);
}

/**
 * Convert a FilterExpression into Drizzle SQL conditions.
 * Returns an array of SQL conditions that should be composed with and()/or()
 * based on the expression's logical operator.
 */
export function filterToSqlConditions(
  expr: FilterExpression,
  table: ItemsTableRef,
  sources?: TypeFilter,
): SQL[] {
  return expr.conditions.map((c) => conditionToSql(c, table, sources));
}

// ---------------------------------------------------------------------------
// The `source_filter` enforcement lever
// ---------------------------------------------------------------------------

/**
 * The lever's configured shape, as the storage layer consumes it: for each
 * listed type, reads return only rows whose `source` is in `sources`.
 */
export interface SourceFilterSettings {
  types: string[];
  sources: string[];
}

/**
 * The roots the lever covers, each with everything named under it.
 *
 * A configured identifier covers its subtree, because that is what a read of
 * that identifier has always selected: `?type=core.note` returns
 * `core.note.private` too, so a lever listing `core.note` that skipped the
 * subtype would narrow only part of the view it is meant to narrow.
 */
function decomposeCoveredTypes(types: string[]): {
  global: boolean;
  roots: string[];
} {
  const roots: string[] = [];
  for (const configured of types) {
    if (configured === GLOBAL_TYPE_WILDCARD) return { global: true, roots: [] };
    const root = subtreeWildcardRoot(configured) ?? configured;
    roots.push(root);
    // A declared descendant is covered as a root of its own, or a lever
    // narrowing a subtree would leave the member named outside that
    // subtree's namespace unnarrowed.
    roots.push(...declaredDescendantsOutsideNamespace(root));
  }
  return { global: false, roots };
}

export function sourceFilterIncludesItem(
  filter: SourceFilterSettings | undefined,
  item: { type: string; source: string },
): boolean {
  if (!filter) return true;
  const { global, roots } = decomposeCoveredTypes(filter.types);
  const covered =
    global ||
    roots.some(
      (root) => item.type === root || item.type.startsWith(`${root}.`),
    );
  return !covered || filter.sources.includes(item.source);
}

export function canonicalSourceFilter(
  filter: SourceFilterSettings | undefined,
): { types: string[]; sources: string[] } | null {
  if (!filter) return null;
  const covered = decomposeCoveredTypes(filter.types);
  const roots = [...new Set(covered.roots)].sort();
  const types = covered.global
    ? ["*"]
    : roots.filter(
        (root) =>
          !roots.some(
            (ancestor) => root !== ancestor && root.startsWith(`${ancestor}.`),
          ),
      );
  if (types.length === 0) return null;
  return { types, sources: [...new Set(filter.sources)].sort() };
}

/**
 * The `source_filter` lever as a row predicate, for the Drizzle query path.
 *
 * The lever is per-type: a covered row must carry an approved source, and
 * every row it does not cover passes untouched. Coverage is decided from the
 * row's own type rather than from the request's `?type=` parameter, which is
 * what stops a caller switching the control off by broadening the query — a
 * bare listing, an ancestor wildcard, a tier filter and a state filter all
 * select a covered row without naming its type.
 *
 * Returns undefined when the lever is off for every type it lists, so callers
 * push the result only when it is present.
 */
export function sourceFilterToSql(
  filter: SourceFilterSettings | undefined,
  typeCol: SQLWrapper,
  sourceCol: SQLWrapper,
): SQL | undefined {
  if (!filter) return undefined;
  const { global, roots } = decomposeCoveredTypes(filter.types);
  if (!global && roots.length === 0) return undefined;

  const covered = global
    ? sql`1=1`
    : sql.join(
        roots.map((root) => namedSubtreeSql(typeCol, root)),
        sql` OR `,
      );

  // An empty source list approves nothing, so covered rows drop out entirely.
  // Emitting `IN ()` instead is a syntax error.
  if (filter.sources.length === 0) return sql`NOT (${covered})`;

  return sql`(NOT (${covered}) OR ${sourceCol} IN (${sql.join(
    filter.sources.map((source) => sql`${source}`),
    sql`, `,
  )}))`;
}
