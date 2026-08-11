/**
 * SQL condition generator for the advanced query language.
 *
 * Converts a FilterExpression AST into SQL conditions for both:
 * - Drizzle ORM (used by item stores): returns SQL[] to compose with and()/or()
 * - Raw SQL strings (used by search stores): returns parameterized clause strings
 *
 * Supports both SQLite and Postgres dialects.
 */

import { sql, type SQL } from "drizzle-orm";
import { typeSubtreeToSql } from "@withmarfa/shared";
import type {
  FilterExpression,
  FilterCondition,
  ComparisonOp,
} from "@withmarfa/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape LIKE pattern characters so they are treated as literals.
 *
 * Only half the job: the escape character has to be declared too. Postgres
 * defaults to backslash, SQLite has no default at all, so on SQLite an
 * unaccompanied `\_` is a literal backslash followed by the single-character
 * wildcard — a `contains` filter for `web_gallery` silently matches nothing.
 * Every LIKE built from this must carry `LIKE_ESCAPE_CLAUSE`, which reads the
 * same on both dialects.
 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Declares the escape character `escapeLike` writes. Append to every LIKE. */
const LIKE_ESCAPE_CLAUSE = " ESCAPE '\\'";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SqlDialect = "sqlite" | "pg";

/** Table reference with the columns we need for condition generation. */
interface ItemsTableRef {
  id: unknown;
  state: unknown;
  type: unknown;
  source: unknown;
  source_id: unknown;
  timestamp: unknown;
  created_at: unknown;
  updated_at: unknown;
  tier: unknown;
  device: unknown;
  version: unknown;
  properties: unknown;
}

export interface RawSqlResult {
  clause: string;
  params: unknown[];
  nextParamIdx: number;
}

// ---------------------------------------------------------------------------
// System field column mapping (for Drizzle)
// ---------------------------------------------------------------------------

function getSystemColumn(table: ItemsTableRef, column: string): unknown {
  const map: Record<string, unknown> = {
    state: table.state,
    type: table.type,
    source: table.source,
    source_id: table.source_id,
    timestamp: table.timestamp,
    created_at: table.created_at,
    updated_at: table.updated_at,
    tier: table.tier,
    device: table.device,
    version: table.version,
    id: table.id,
  };
  return map[column];
}

// ---------------------------------------------------------------------------
// Drizzle SQL condition generator (for item stores)
// ---------------------------------------------------------------------------

function conditionToSql(
  condition: FilterCondition,
  dialect: SqlDialect,
  table: ItemsTableRef,
  spaceId: string | undefined,
): SQL {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    const col = getSystemColumn(table, field.column);
    return systemFieldSql(col, op, value, dialect);
  }

  if (field.kind === "property") {
    return propertyFieldSql(table.properties, field.path, op, value, dialect);
  }

  if (field.kind === "edge") {
    return edgeFieldSql(
      table.id,
      field.edge_type,
      field.direction,
      op,
      value,
      spaceId,
    );
  }

  // tags
  return tagsFieldSql(table.id, op, value, dialect);
}

/**
 * Edge-membership filter. Direction = "outbound" → item is the source of an
 * edge of the given type pointing to `value` (or any edge with exists op).
 * Direction = "backref" → item is the target of such an edge.
 *
 * `spaceId` (when provided) constrains the subquery to the caller's space —
 * defense-in-depth alongside the outer query's `i.space_id = ?`. When
 * undefined (admin / cross-space queries), no extra constraint is added.
 */
function edgeFieldSql(
  idCol: unknown,
  edgeType: string,
  direction: "outbound" | "backref",
  op: ComparisonOp,
  value: unknown,
  spaceId: string | undefined,
): SQL {
  // Space scoping — only emit when a space is in scope. `sql.empty()` keeps
  // the template stable when no space is set (prevents stray param binding).
  const spaceClause = spaceId ? sql` AND e.space_id = ${spaceId}` : sql.empty();

  if (direction === "outbound") {
    switch (op) {
      case "eq":
        return sql`EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol}
            AND e.edge_type = ${edgeType}
            AND e.target_id = ${value}${spaceClause}
        )`;
      case "neq":
        return sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol}
            AND e.edge_type = ${edgeType}
            AND e.target_id = ${value}${spaceClause}
        )`;
      case "exists":
        return sql`EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol} AND e.edge_type = ${edgeType}${spaceClause}
        )`;
      case "not_exists":
        return sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.source_id = ${idCol} AND e.edge_type = ${edgeType}${spaceClause}
        )`;
      default:
        throw new Error(`Unsupported operator "${op}" for edge reference`);
    }
  }
  // backref
  switch (op) {
    case "eq":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value}${spaceClause}
      )`;
    case "neq":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value}${spaceClause}
      )`;
    case "exists":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType}${spaceClause}
      )`;
    case "not_exists":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType}${spaceClause}
      )`;
    default:
      throw new Error(`Unsupported operator "${op}" for edge reference`);
  }
}

/** better-sqlite3 cannot bind booleans natively (the column is INTEGER
 * under the hood); coerce to 0/1 for the SQLite path. Postgres needs the
 * boolean itself because boolean columns are real `bool` and `boolean =
 * integer` is a type error. */
function bindable(value: unknown, dialect: SqlDialect): unknown {
  if (typeof value === "boolean" && dialect === "sqlite") return value ? 1 : 0;
  return value;
}

function systemFieldSql(
  col: unknown,
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
): SQL {
  const v = bindable(value, dialect);
  switch (op) {
    case "eq":
      return sql`${col} = ${v}`;
    case "neq":
      return sql`${col} != ${v}`;
    case "gt":
      return sql`${col} > ${v}`;
    case "gte":
      return sql`${col} >= ${v}`;
    case "lt":
      return sql`${col} < ${v}`;
    case "lte":
      return sql`${col} <= ${v}`;
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
  dialect: SqlDialect,
): SQL {
  const jsonPath = `$.${path}`;
  const isNumeric = typeof value === "number";

  // JSON extraction expression varies by dialect: sqlite's json_extract
  // reads the JSONB blob directly; pg reads the jsonb column natively.
  const extract =
    dialect === "sqlite"
      ? sql`json_extract(${propertiesCol}, ${jsonPath})`
      : sql`${propertiesCol}->>${path}`;

  // Numeric extraction for comparison operators
  const numericExtract =
    dialect === "sqlite"
      ? sql`CAST(json_extract(${propertiesCol}, ${jsonPath}) AS REAL)`
      : sql`(${propertiesCol}->>${path})::numeric`;

  switch (op) {
    case "eq":
      return sql`${extract} = ${value}`;
    case "neq":
      return sql`${extract} != ${value}`;
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

function tagsFieldSql(
  idCol: unknown,
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
): SQL {
  if (op === "contains") {
    if (dialect === "sqlite") {
      return sql`EXISTS (
        SELECT 1 FROM metadata m, json_each(m.tags) je
        WHERE m.item_id = ${idCol} AND je.value = ${value}
      )`;
    }
    // Postgres: wrap value in array for jsonb containment
    return sql`EXISTS (
      SELECT 1 FROM metadata m
      WHERE m.item_id = ${idCol}
        AND m.tags::jsonb @> ${JSON.stringify([value])}::jsonb
    )`;
  }

  if (op === "exists") {
    if (dialect === "sqlite") {
      return sql`EXISTS (
        SELECT 1 FROM metadata m, json_each(m.tags) je
        WHERE m.item_id = ${idCol}
      )`;
    }
    return sql`EXISTS (
      SELECT 1 FROM metadata m
      WHERE m.item_id = ${idCol}
        AND jsonb_array_length(m.tags::jsonb) > 0
    )`;
  }

  if (op === "not_exists") {
    if (dialect === "sqlite") {
      return sql`NOT EXISTS (
        SELECT 1 FROM metadata m, json_each(m.tags) je
        WHERE m.item_id = ${idCol}
      )`;
    }
    return sql`NOT EXISTS (
      SELECT 1 FROM metadata m
      WHERE m.item_id = ${idCol}
        AND jsonb_array_length(m.tags::jsonb) > 0
    )`;
  }

  throw new Error(`Unsupported operator "${op}" for tags`);
}

/**
 * Convert a FilterExpression into Drizzle SQL conditions.
 * Returns an array of SQL conditions that should be composed with and()/or()
 * based on the expression's logical operator.
 *
 * `spaceId` (when provided) scopes edge subqueries to the caller's space —
 * defense-in-depth alongside the outer query's space filter. Pass undefined
 * for admin / cross-space queries.
 */
export function filterToSqlConditions(
  expr: FilterExpression,
  dialect: SqlDialect,
  table: ItemsTableRef,
  spaceId?: string,
): SQL[] {
  return expr.conditions.map((c) => conditionToSql(c, dialect, table, spaceId));
}

// ---------------------------------------------------------------------------
// Raw SQL condition generator (for search stores)
// ---------------------------------------------------------------------------

function conditionToRawSql(
  condition: FilterCondition,
  dialect: SqlDialect,
  tableAlias: string,
  params: unknown[],
  paramIdx: number,
  spaceId: string | undefined,
): { fragment: string; paramIdx: number } {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    return systemFieldRawSql(
      tableAlias,
      field.column,
      op,
      value,
      dialect,
      params,
      paramIdx,
    );
  }

  if (field.kind === "property") {
    return propertyFieldRawSql(
      tableAlias,
      field.path,
      op,
      value,
      dialect,
      params,
      paramIdx,
    );
  }

  if (field.kind === "edge") {
    return edgeFieldRawSql(
      tableAlias,
      field.edge_type,
      field.direction,
      op,
      value,
      dialect,
      params,
      paramIdx,
      spaceId,
    );
  }

  // tags
  return tagsFieldRawSql(tableAlias, op, value, dialect, params, paramIdx);
}

function edgeFieldRawSql(
  alias: string,
  edgeType: string,
  direction: "outbound" | "backref",
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
  params: unknown[],
  idx: number,
  spaceId: string | undefined,
): { fragment: string; paramIdx: number } {
  const idColumn = direction === "outbound" ? "e.source_id" : "e.target_id";
  const otherColumn = direction === "outbound" ? "e.target_id" : "e.source_id";

  if (op === "exists" || op === "not_exists") {
    const typePh = placeholder(dialect, idx);
    params.push(edgeType);
    let nextIdx = idx + 1;
    let spaceFragment = "";
    if (spaceId !== undefined) {
      const spacePh = placeholder(dialect, nextIdx);
      params.push(spaceId);
      spaceFragment = ` AND e.space_id = ${spacePh}`;
      nextIdx += 1;
    }
    const prefix = op === "exists" ? "EXISTS" : "NOT EXISTS";
    return {
      fragment: `${prefix} (SELECT 1 FROM edges e WHERE ${idColumn} = ${alias}.id AND e.edge_type = ${typePh}${spaceFragment})`,
      paramIdx: nextIdx,
    };
  }

  if (op === "eq" || op === "neq") {
    const typePh = placeholder(dialect, idx);
    params.push(edgeType);
    const valPh = placeholder(dialect, idx + 1);
    params.push(value);
    let nextIdx = idx + 2;
    let spaceFragment = "";
    if (spaceId !== undefined) {
      const spacePh = placeholder(dialect, nextIdx);
      params.push(spaceId);
      spaceFragment = ` AND e.space_id = ${spacePh}`;
      nextIdx += 1;
    }
    const prefix = op === "eq" ? "EXISTS" : "NOT EXISTS";
    return {
      fragment: `${prefix} (SELECT 1 FROM edges e WHERE ${idColumn} = ${alias}.id AND e.edge_type = ${typePh} AND ${otherColumn} = ${valPh}${spaceFragment})`,
      paramIdx: nextIdx,
    };
  }

  throw new Error(`Unsupported operator "${op}" for edge reference in raw SQL`);
}

function placeholder(dialect: SqlDialect, idx: number): string {
  return dialect === "sqlite" ? "?" : `$${String(idx)}`;
}

function systemFieldRawSql(
  alias: string,
  column: string,
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
  params: unknown[],
  idx: number,
): { fragment: string; paramIdx: number } {
  const col = `${alias}.${column}`;
  const p = placeholder(dialect, idx);

  switch (op) {
    case "eq":
      params.push(value);
      return { fragment: `${col} = ${p}`, paramIdx: idx + 1 };
    case "neq":
      params.push(value);
      return { fragment: `${col} != ${p}`, paramIdx: idx + 1 };
    case "gt":
      params.push(value);
      return { fragment: `${col} > ${p}`, paramIdx: idx + 1 };
    case "gte":
      params.push(value);
      return { fragment: `${col} >= ${p}`, paramIdx: idx + 1 };
    case "lt":
      params.push(value);
      return { fragment: `${col} < ${p}`, paramIdx: idx + 1 };
    case "lte":
      params.push(value);
      return { fragment: `${col} <= ${p}`, paramIdx: idx + 1 };
    case "contains": {
      params.push("%" + escapeLike(String(value)) + "%");
      return {
        fragment: `${col} LIKE ${p}${LIKE_ESCAPE_CLAUSE}`,
        paramIdx: idx + 1,
      };
    }
    case "starts_with": {
      params.push(escapeLike(String(value)) + "%");
      return {
        fragment: `${col} LIKE ${p}${LIKE_ESCAPE_CLAUSE}`,
        paramIdx: idx + 1,
      };
    }
    default:
      throw new Error(
        `Unsupported operator "${op}" for system field in raw SQL`,
      );
  }
}

function propertyFieldRawSql(
  alias: string,
  path: string,
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
  params: unknown[],
  idx: number,
): { fragment: string; paramIdx: number } {
  const isNumeric = typeof value === "number";

  if (dialect === "sqlite") {
    const pathPlaceholder = placeholder(dialect, idx);
    const jsonPath = `$.${path}`;
    params.push(jsonPath);
    idx++;
    const extract = `json_extract(${alias}.properties, ${pathPlaceholder})`;
    const numExtract = `CAST(${extract} AS REAL)`;

    return propertyOpRawSql(
      op,
      extract,
      numExtract,
      isNumeric,
      value,
      dialect,
      params,
      idx,
    );
  }

  // Postgres: the jsonb column answers ->> natively
  const pathPlaceholder = placeholder(dialect, idx);
  params.push(path);
  idx++;
  const extract = `${alias}.properties->>${pathPlaceholder}`;
  const numExtract = `(${extract})::numeric`;

  return propertyOpRawSql(
    op,
    extract,
    numExtract,
    isNumeric,
    value,
    dialect,
    params,
    idx,
  );
}

function propertyOpRawSql(
  op: ComparisonOp,
  extract: string,
  numExtract: string,
  isNumeric: boolean,
  value: unknown,
  dialect: SqlDialect,
  params: unknown[],
  idx: number,
): { fragment: string; paramIdx: number } {
  const p = placeholder(dialect, idx);

  switch (op) {
    case "eq":
      params.push(value);
      return { fragment: `${extract} = ${p}`, paramIdx: idx + 1 };
    case "neq":
      params.push(value);
      return { fragment: `${extract} != ${p}`, paramIdx: idx + 1 };
    case "gt": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return { fragment: `${expr} > ${p}`, paramIdx: idx + 1 };
    }
    case "gte": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return { fragment: `${expr} >= ${p}`, paramIdx: idx + 1 };
    }
    case "lt": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return { fragment: `${expr} < ${p}`, paramIdx: idx + 1 };
    }
    case "lte": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return { fragment: `${expr} <= ${p}`, paramIdx: idx + 1 };
    }
    case "contains": {
      params.push("%" + escapeLike(String(value)) + "%");
      return {
        fragment: `${extract} LIKE ${p}${LIKE_ESCAPE_CLAUSE}`,
        paramIdx: idx + 1,
      };
    }
    case "starts_with": {
      params.push(escapeLike(String(value)) + "%");
      return {
        fragment: `${extract} LIKE ${p}${LIKE_ESCAPE_CLAUSE}`,
        paramIdx: idx + 1,
      };
    }
    case "exists":
      return { fragment: `${extract} IS NOT NULL`, paramIdx: idx };
    case "not_exists":
      return { fragment: `${extract} IS NULL`, paramIdx: idx };
    default:
      throw new Error(
        `Unsupported operator "${String(op)}" for property in raw SQL`,
      );
  }
}

function tagsFieldRawSql(
  alias: string,
  op: ComparisonOp,
  value: unknown,
  dialect: SqlDialect,
  params: unknown[],
  idx: number,
): { fragment: string; paramIdx: number } {
  if (op === "contains") {
    if (dialect === "sqlite") {
      const p = placeholder(dialect, idx);
      params.push(value);
      return {
        fragment: `EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id AND je.value = ${p})`,
        paramIdx: idx + 1,
      };
    }
    const p = placeholder(dialect, idx);
    params.push(JSON.stringify([value]));
    return {
      fragment: `EXISTS (SELECT 1 FROM metadata m WHERE m.item_id = ${alias}.id AND m.tags::jsonb @> ${p}::jsonb)`,
      paramIdx: idx + 1,
    };
  }

  if (op === "exists") {
    if (dialect === "sqlite") {
      return {
        fragment: `EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id)`,
        paramIdx: idx,
      };
    }
    return {
      fragment: `EXISTS (SELECT 1 FROM metadata m WHERE m.item_id = ${alias}.id AND jsonb_array_length(m.tags::jsonb) > 0)`,
      paramIdx: idx,
    };
  }

  if (op === "not_exists") {
    if (dialect === "sqlite") {
      return {
        fragment: `NOT EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id)`,
        paramIdx: idx,
      };
    }
    return {
      fragment: `NOT EXISTS (SELECT 1 FROM metadata m WHERE m.item_id = ${alias}.id AND jsonb_array_length(m.tags::jsonb) > 0)`,
      paramIdx: idx,
    };
  }

  throw new Error(`Unsupported operator "${op}" for tags in raw SQL`);
}

/**
 * Convert a FilterExpression into a raw SQL WHERE clause fragment.
 *
 * @param expr - The parsed filter expression
 * @param dialect - "sqlite" or "pg"
 * @param tableAlias - Table alias used in the query (e.g., "i")
 * @param startParamIdx - Starting parameter index (Postgres only, default 1)
 * @param spaceId - Optional space scope for edge subqueries (defense-in-depth)
 * @returns The SQL clause, parameter values, and next parameter index
 */
export function filterToRawSql(
  expr: FilterExpression,
  dialect: SqlDialect,
  tableAlias: string,
  startParamIdx = 1,
  spaceId?: string,
): RawSqlResult {
  const params: unknown[] = [];
  let paramIdx = startParamIdx;
  const fragments: string[] = [];

  for (const condition of expr.conditions) {
    const result = conditionToRawSql(
      condition,
      dialect,
      tableAlias,
      params,
      paramIdx,
      spaceId,
    );
    fragments.push(result.fragment);
    paramIdx = result.paramIdx;
  }

  const joiner = expr.logical === "OR" ? " OR " : " AND ";
  const clause =
    fragments.length === 1
      ? (fragments[0] ?? "")
      : `(${fragments.join(joiner)})`;

  return { clause, params, nextParamIdx: paramIdx };
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
 * Which configured entries the predicate has to compile, pre-decomposed so
 * the two emitters below bind parameters in their own order.
 *
 * A configured identifier covers its subtree, because that is what a read of
 * that identifier has always selected: `?type=core.note` returns
 * `core.note.private` too, so a lever listing `core.note` that skipped the
 * subtype would narrow only part of the view it is meant to narrow.
 */
function decomposeCoveredTypes(
  types: string[],
  spaceId?: string | null,
): {
  global: boolean;
  pairs: { exact: string; descendantPattern: string }[];
} {
  const pairs: { exact: string; descendantPattern: string }[] = [];
  for (const configured of types) {
    const { global, exact, descendantPattern, extraTypes } = typeSubtreeToSql(
      configured,
      spaceId,
    );
    if (global) return { global: true, pairs: [] };
    if (exact !== null && descendantPattern !== null) {
      pairs.push({ exact, descendantPattern });
    }
    // A declared descendant needs no LIKE of its own — its identifier is
    // already exact — but it must be covered, or a lever narrowing a subtree
    // would leave the member named outside that subtree's namespace unnarrowed.
    for (const extra of extraTypes) {
      pairs.push({ exact: extra, descendantPattern: `${extra}.%` });
    }
  }
  return { global: false, pairs };
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
  typeCol: unknown,
  sourceCol: unknown,
  spaceId?: string | null,
): SQL | undefined {
  if (!filter) return undefined;
  const { global, pairs } = decomposeCoveredTypes(filter.types, spaceId);
  if (!global && pairs.length === 0) return undefined;

  const covered = global
    ? sql`1=1`
    : pairs
        .map(
          (p) =>
            sql`(${typeCol} = ${p.exact} OR ${typeCol} LIKE ${p.descendantPattern} ESCAPE '\\')`,
        )
        .reduce(
          (acc, clause, i) => (i === 0 ? clause : sql`${acc} OR ${clause}`),
          sql``,
        );

  // An empty source list approves nothing, so covered rows drop out entirely.
  // Emitting `IN ()` instead is a syntax error on both dialects.
  if (filter.sources.length === 0) return sql`NOT (${covered})`;

  const list = filter.sources
    .map((s) => sql`${s}`)
    .reduce(
      (acc, value, i) => (i === 0 ? value : sql`${acc}, ${value}`),
      sql``,
    );
  return sql`(NOT (${covered}) OR ${sourceCol} IN (${list}))`;
}

/**
 * The same predicate for the raw-SQL query path the search stores build.
 *
 * Returns null when the lever is off, mirroring `sourceFilterToSql`'s
 * undefined. The clause is unparenthesized at the top level; callers append
 * it with their own `AND `.
 */
export function sourceFilterToRawSql(
  filter: SourceFilterSettings | undefined,
  dialect: SqlDialect,
  tableAlias: string,
  startParamIdx = 1,
  spaceId?: string | null,
): RawSqlResult | null {
  if (!filter) return null;
  const { global, pairs } = decomposeCoveredTypes(filter.types, spaceId);
  if (!global && pairs.length === 0) return null;

  const params: unknown[] = [];
  let idx = startParamIdx;
  const typeCol = `${tableAlias}.type`;

  let covered: string;
  if (global) {
    covered = "1=1";
  } else {
    covered = pairs
      .map((p) => {
        const exactPh = placeholder(dialect, idx++);
        params.push(p.exact);
        const likePh = placeholder(dialect, idx++);
        params.push(p.descendantPattern);
        return `(${typeCol} = ${exactPh} OR ${typeCol} LIKE ${likePh}${LIKE_ESCAPE_CLAUSE})`;
      })
      .join(" OR ");
  }

  if (filter.sources.length === 0) {
    return { clause: `NOT (${covered})`, params, nextParamIdx: idx };
  }

  const list = filter.sources
    .map((s) => {
      const ph = placeholder(dialect, idx++);
      params.push(s);
      return ph;
    })
    .join(", ");
  return {
    clause: `(NOT (${covered}) OR ${tableAlias}.source IN (${list}))`,
    params,
    nextParamIdx: idx,
  };
}
