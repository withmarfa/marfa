/**
 * SQL condition generator for the advanced query language.
 *
 * Converts a FilterExpression AST into SQL conditions for both:
 * - Drizzle ORM (used by item stores): returns SQL[] to compose with and()/or()
 * - Raw SQL strings (used by search stores): returns parameterized clause strings
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
 * Only half the job: the escape character has to be declared too. SQLite
 * has no default, so an unaccompanied `\_` is a literal backslash followed
 * by the single-character wildcard — a `contains` filter for `web_gallery`
 * silently matches nothing. Every LIKE built from this must carry
 * `LIKE_ESCAPE_CLAUSE`.
 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Declares the escape character `escapeLike` writes. Append to every LIKE. */
const LIKE_ESCAPE_CLAUSE = " ESCAPE '\\'";

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

export interface RawSqlResult {
  clause: string;
  params: unknown[];
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
// Drizzle SQL condition generator (for item stores)
// ---------------------------------------------------------------------------

function conditionToSql(condition: FilterCondition, table: ItemsTableRef): SQL {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    const col = getSystemColumn(table, field.column);
    return systemFieldSql(col, op, value);
  }

  if (field.kind === "property") {
    return propertyFieldSql(table.properties, field.path, op, value);
  }

  if (field.kind === "edge") {
    return edgeFieldSql(table.id, field.edge_type, field.direction, op, value);
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
  // backref
  switch (op) {
    case "eq":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value}
      )`;
    case "neq":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol}
          AND e.edge_type = ${edgeType}
          AND e.source_id = ${value}
      )`;
    case "exists":
      return sql`EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType}
      )`;
    case "not_exists":
      return sql`NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target_id = ${idCol} AND e.edge_type = ${edgeType}
      )`;
    default:
      throw new Error(`Unsupported operator "${op}" for edge reference`);
  }
}

/** libsql cannot bind booleans natively (the column is INTEGER under the
 * hood); coerce to 0/1. */
function bindable(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function systemFieldSql(col: unknown, op: ComparisonOp, value: unknown): SQL {
  const v = bindable(value);
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
): SQL {
  const jsonPath = `$.${path}`;
  const isNumeric = typeof value === "number";

  // json_extract reads the JSONB blob directly.
  const extract = sql`json_extract(${propertiesCol}, ${jsonPath})`;

  // Numeric extraction for comparison operators
  const numericExtract = sql`CAST(json_extract(${propertiesCol}, ${jsonPath}) AS REAL)`;

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
): SQL[] {
  return expr.conditions.map((c) => conditionToSql(c, table));
}

// ---------------------------------------------------------------------------
// Raw SQL condition generator (for search stores)
// ---------------------------------------------------------------------------

function conditionToRawSql(
  condition: FilterCondition,
  tableAlias: string,
  params: unknown[],
): string {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    return systemFieldRawSql(tableAlias, field.column, op, value, params);
  }

  if (field.kind === "property") {
    return propertyFieldRawSql(tableAlias, field.path, op, value, params);
  }

  if (field.kind === "edge") {
    return edgeFieldRawSql(
      tableAlias,
      field.edge_type,
      field.direction,
      op,
      value,
      params,
    );
  }

  // tags
  return tagsFieldRawSql(tableAlias, op, value, params);
}

function edgeFieldRawSql(
  alias: string,
  edgeType: string,
  direction: "outbound" | "backref",
  op: ComparisonOp,
  value: unknown,
  params: unknown[],
): string {
  const idColumn = direction === "outbound" ? "e.source_id" : "e.target_id";
  const otherColumn = direction === "outbound" ? "e.target_id" : "e.source_id";

  if (op === "exists" || op === "not_exists") {
    params.push(edgeType);
    const prefix = op === "exists" ? "EXISTS" : "NOT EXISTS";
    return `${prefix} (SELECT 1 FROM edges e WHERE ${idColumn} = ${alias}.id AND e.edge_type = ?)`;
  }

  if (op === "eq" || op === "neq") {
    params.push(edgeType);
    params.push(value);
    const prefix = op === "eq" ? "EXISTS" : "NOT EXISTS";
    return `${prefix} (SELECT 1 FROM edges e WHERE ${idColumn} = ${alias}.id AND e.edge_type = ? AND ${otherColumn} = ?)`;
  }

  throw new Error(`Unsupported operator "${op}" for edge reference in raw SQL`);
}

function systemFieldRawSql(
  alias: string,
  column: string,
  op: ComparisonOp,
  value: unknown,
  params: unknown[],
): string {
  const col = `${alias}.${column}`;

  switch (op) {
    case "eq":
      params.push(value);
      return `${col} = ?`;
    case "neq":
      params.push(value);
      return `${col} != ?`;
    case "gt":
      params.push(value);
      return `${col} > ?`;
    case "gte":
      params.push(value);
      return `${col} >= ?`;
    case "lt":
      params.push(value);
      return `${col} < ?`;
    case "lte":
      params.push(value);
      return `${col} <= ?`;
    case "contains":
      params.push("%" + escapeLike(String(value)) + "%");
      return `${col} LIKE ?${LIKE_ESCAPE_CLAUSE}`;
    case "starts_with":
      params.push(escapeLike(String(value)) + "%");
      return `${col} LIKE ?${LIKE_ESCAPE_CLAUSE}`;
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
  params: unknown[],
): string {
  const isNumeric = typeof value === "number";
  params.push(`$.${path}`);
  const extract = `json_extract(${alias}.properties, ?)`;
  const numExtract = `CAST(${extract} AS REAL)`;

  switch (op) {
    case "eq":
      params.push(value);
      return `${extract} = ?`;
    case "neq":
      params.push(value);
      return `${extract} != ?`;
    case "gt": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return `${expr} > ?`;
    }
    case "gte": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return `${expr} >= ?`;
    }
    case "lt": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return `${expr} < ?`;
    }
    case "lte": {
      const expr = isNumeric ? numExtract : extract;
      params.push(value);
      return `${expr} <= ?`;
    }
    case "contains":
      params.push("%" + escapeLike(String(value)) + "%");
      return `${extract} LIKE ?${LIKE_ESCAPE_CLAUSE}`;
    case "starts_with":
      params.push(escapeLike(String(value)) + "%");
      return `${extract} LIKE ?${LIKE_ESCAPE_CLAUSE}`;
    case "exists":
      return `${extract} IS NOT NULL`;
    case "not_exists":
      return `${extract} IS NULL`;
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
  params: unknown[],
): string {
  if (op === "contains") {
    params.push(value);
    return `EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id AND je.value = ?)`;
  }

  if (op === "exists") {
    return `EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id)`;
  }

  if (op === "not_exists") {
    return `NOT EXISTS (SELECT 1 FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${alias}.id)`;
  }

  throw new Error(`Unsupported operator "${op}" for tags in raw SQL`);
}

/**
 * Convert a FilterExpression into a raw SQL WHERE clause fragment.
 *
 * @param expr - The parsed filter expression
 * @param tableAlias - Table alias used in the query (e.g., "i")
 * @returns The SQL clause and its positional parameter values
 */
export function filterToRawSql(
  expr: FilterExpression,
  tableAlias: string,
): RawSqlResult {
  const params: unknown[] = [];
  const fragments: string[] = [];

  for (const condition of expr.conditions) {
    fragments.push(conditionToRawSql(condition, tableAlias, params));
  }

  const joiner = expr.logical === "OR" ? " OR " : " AND ";
  const clause =
    fragments.length === 1
      ? (fragments[0] ?? "")
      : `(${fragments.join(joiner)})`;

  return { clause, params };
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
function decomposeCoveredTypes(types: string[]): {
  global: boolean;
  pairs: { exact: string; descendantPattern: string }[];
} {
  const pairs: { exact: string; descendantPattern: string }[] = [];
  for (const configured of types) {
    const { global, exact, descendantPattern, extraTypes } =
      typeSubtreeToSql(configured);
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
): SQL | undefined {
  if (!filter) return undefined;
  const { global, pairs } = decomposeCoveredTypes(filter.types);
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
  // Emitting `IN ()` instead is a syntax error.
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
  tableAlias: string,
): RawSqlResult | null {
  if (!filter) return null;
  const { global, pairs } = decomposeCoveredTypes(filter.types);
  if (!global && pairs.length === 0) return null;

  const params: unknown[] = [];
  const typeCol = `${tableAlias}.type`;

  let covered: string;
  if (global) {
    covered = "1=1";
  } else {
    covered = pairs
      .map((p) => {
        params.push(p.exact);
        params.push(p.descendantPattern);
        return `(${typeCol} = ? OR ${typeCol} LIKE ?${LIKE_ESCAPE_CLAUSE})`;
      })
      .join(" OR ");
  }

  if (filter.sources.length === 0) {
    return { clause: `NOT (${covered})`, params };
  }

  const list = filter.sources
    .map((s) => {
      params.push(s);
      return "?";
    })
    .join(", ");
  return {
    clause: `(NOT (${covered}) OR ${tableAlias}.source IN (${list}))`,
    params,
  };
}
