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
  statusFieldsByType,
  subtreeWildcardRoot,
  typeFilterTerms,
  withHostsEdgeTypes,
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
 * A `type` list as one predicate: an item matches when it matches any entry,
 * each read as {@link typeSubtreeSql} reads it. `undefined` when the list
 * restricts nothing: no list, or an entry that is the global wildcard.
 */
export function typesSql(
  column: SQLWrapper,
  types: readonly string[] | undefined,
): SQL | undefined {
  if (types === undefined || types.length === 0) return undefined;
  const clauses: SQL[] = [];
  for (const type of types) {
    const clause = typeSubtreeSql(column, type);
    if (clause === undefined) return undefined;
    clauses.push(clause);
  }
  return clauses.length === 1
    ? clauses[0]
    : sql`(${sql.join(clauses, sql` OR `)})`;
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
 * What a `backref` term may count: the edges whose source item the reader
 * may read under its type map and that its source filter shows, as every
 * door that serves an edge decides (`edges/read-source-filter`).
 */
export interface ReadableSources {
  /** The reader's type map; omitted for no credential, which counts every
   *  edge the source filter shows. */
  types?: TypeFilter;
  source_filter?: SourceFilterSettings;
}

/**
 * The clause a `backref` term adds so it counts only edges whose source
 * item `sources` admits; empty when nothing narrows it. The source item must
 * exist even when the map reads every type.
 */
function readableSourceSql(sources: ReadableSources | undefined): SQL {
  const byType =
    sources?.types?.allowed === undefined
      ? undefined
      : (typeFilterSql(sql`s.type`, sources.types) ?? sql`1=1`);
  const bySource = sourceFilterToSql(
    sources?.source_filter,
    sql`s.type`,
    sql`s.source`,
  );
  if (byType === undefined && bySource === undefined) return sql``;
  const admitted = sql.join(
    [byType, bySource].filter((clause) => clause !== undefined),
    sql` AND `,
  );
  return sql`AND EXISTS (SELECT 1 FROM items s WHERE s.id = e.source_id AND ${admitted})`;
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
    source: sourceColumnSql(table.source as SQLWrapper),
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
  sources: ReadableSources | undefined,
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

  if (field.kind === "entry") {
    return entryMemberSql(table.properties, field.path, field.member, value);
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

  if (field.kind === "status_group") {
    return statusGroupSql(table.type, table.properties, op, value);
  }

  if (field.kind === "part") {
    const part = partSql(table.id, table.state);
    return (value === true) === (op === "eq") ? part : sql`NOT ${part}`;
  }

  // tags
  return tagsFieldSql(table.id, op, value);
}

/**
 * A `status_group` term, resolved through each registered type's status
 * field: the row's type picks the field and the words, and the words pick
 * the group. Types that share a field and the same words are compared
 * together. A row whose type has no status field, or whose value is no word
 * its type declares, is in no group, so `eq` and `neq` both pass it by and
 * `not_exists` takes it.
 */
function statusGroupSql(
  typeCol: unknown,
  propertiesCol: unknown,
  op: ComparisonOp,
  value: unknown,
): SQL {
  const wanted = (group: string): boolean => {
    switch (op) {
      case "eq":
        return group === value;
      case "neq":
        return group !== value;
      default:
        return true;
    }
  };
  const bySelection = new Map<
    string,
    { field: string; words: string[]; types: string[] }
  >();
  for (const { type, field, words } of statusFieldsByType()) {
    const selected = words
      .filter((entry) => wanted(entry.group))
      .map((entry) => entry.value);
    if (selected.length === 0) continue;
    const key = JSON.stringify([field, selected]);
    const entry = bySelection.get(key);
    if (entry) entry.types.push(type);
    else bySelection.set(key, { field, words: selected, types: [type] });
  }
  const clauses = [...bySelection.values()].map(
    ({ field, words, types }) =>
      sql`(${typeCol} IN (${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )}) AND json_extract(${propertiesCol}, ${`$.${JSON.stringify(field)}`}) IN (${sql.join(
        words.map((w) => sql`${w}`),
        sql`, `,
      )}))`,
  );
  const matched =
    clauses.length === 0 ? sql`1=0` : sql`(${sql.join(clauses, sql` OR `)})`;
  // A row whose type matches but holds no value compares as NULL, which
  // `not_exists` must count as absent.
  return op === "not_exists" ? sql`NOT COALESCE(${matched}, 0)` : matched;
}

/**
 * A `part` term: an item out of the bin with at least one edge of a
 * `with-hosts` type to an item out of the bin. Judged over every row,
 * whatever the caller may read, and naming none: the answer is the item's,
 * not its host's.
 */
function partSql(idCol: unknown, stateCol: unknown): SQL {
  const types = withHostsEdgeTypes();
  if (types.length === 0) return sql`(1=0)`;
  return sql`(${stateCol} <> 'trashed' AND EXISTS (
    SELECT 1 FROM edges e JOIN items h ON h.id = e.target_id
    WHERE e.source_id = ${idCol}
      AND e.edge_type IN (${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )})
      AND h.state <> 'trashed'
  ))`;
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
  sources: ReadableSources | undefined,
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

/**
 * `properties.<field>.<member> eq <value>`: some entry of the list in
 * `<field>` is an object whose member equals the value, compared as a
 * property term compares. A field that is not a list matches no row.
 * `CASE`, not `AND`, keeps `json_extract` off an entry that is not an
 * object, which it would refuse as malformed JSON, since SQLite promises no
 * order of evaluation for `AND`. The device's copy is `filter.rs`.
 */
function entryMemberSql(
  propertiesCol: unknown,
  path: string,
  member: string,
  value: unknown,
): SQL {
  const listPath = `$.${path}`;
  const memberPath = `$.${member}`;
  const extract = sql`json_extract(entry.value, ${memberPath})`;
  const compared =
    typeof value === "number"
      ? sql`CASE WHEN entry.type <> 'object' THEN NULL WHEN json_type(entry.value, ${memberPath}) IN ('integer', 'real') THEN CAST(${extract} AS REAL) ELSE ${extract} END`
      : sql`CASE WHEN entry.type = 'object' THEN ${extract} END`;
  return sql`EXISTS (SELECT 1 FROM json_each(${propertiesCol}, ${listPath}) AS entry WHERE json_type(${propertiesCol}, ${listPath}) = 'array' AND ${compared} = ${value})`;
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
  sources?: ReadableSources,
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

/**
 * The source a row stored without one is read as, by every read
 * (`rowToItem`), and so by the source filter in SQL and here alike.
 */
export const MISSING_SOURCE = "unknown";

/**
 * The `source` column as every read answers it. A row stored with a NULL
 * source reads as `unknown`, so every SQL comparison on the column goes
 * through here and agrees with what the row reads as.
 */
export function sourceColumnSql(sourceCol: SQLWrapper): SQL {
  return sql`COALESCE(${sourceCol}, ${MISSING_SOURCE})`;
}

/** Whether the filter names this type, or a type it is under. */
export function sourceFilterCovers(
  filter: SourceFilterSettings | undefined,
  type: string,
): boolean {
  if (!filter) return false;
  const { global, roots } = decomposeCoveredTypes(filter.types);
  return (
    global || roots.some((root) => type === root || type.startsWith(`${root}.`))
  );
}

/**
 * The JavaScript twin of `sourceFilterToSql`, for a row already read. A
 * `source` that is not a string, which no stored row reads as, is named by
 * no filter.
 */
export function sourceFilterIncludesItem(
  filter: SourceFilterSettings | undefined,
  item: { type: string; source?: unknown },
): boolean {
  if (filter === undefined || !sourceFilterCovers(filter, item.type))
    return true;
  return (
    typeof item.source === "string" && filter.sources.includes(item.source)
  );
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

  return sql`(NOT (${covered}) OR ${sourceColumnSql(sourceCol)} IN (${sql.join(
    filter.sources.map((source) => sql`${source}`),
    sql`, `,
  )}))`;
}
