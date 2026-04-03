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
import type {
  FilterExpression,
  FilterCondition,
  ComparisonOp,
} from "@mymehq/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE pattern characters so they are treated as literals. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SqlDialect = "sqlite" | "pg";

/** Table reference with the columns we need for condition generation. */
interface ItemsTableRef {
  id: { name: string };
  state: unknown;
  type: unknown;
  source: unknown;
  origin: unknown;
  timestamp: unknown;
  created_at: unknown;
  updated_at: unknown;
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
    origin: table.origin,
    timestamp: table.timestamp,
    created_at: table.created_at,
    updated_at: table.updated_at,
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
): SQL {
  const { field, op, value } = condition;

  if (field.kind === "system") {
    const col = getSystemColumn(table, field.column);
    return systemFieldSql(col, op, value);
  }

  if (field.kind === "property") {
    return propertyFieldSql(table.properties, field.path, op, value, dialect);
  }

  // tags
  return tagsFieldSql(table.id, op, value, dialect);
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
      return sql`${col} LIKE ${"%" + escapeLike(String(value)) + "%"}`;
    case "starts_with":
      return sql`${col} LIKE ${escapeLike(String(value)) + "%"}`;
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

  // JSON extraction expression varies by dialect
  const extract =
    dialect === "sqlite"
      ? sql`json_extract(${propertiesCol}, ${jsonPath})`
      : sql`${propertiesCol}::json->>${path}`;

  // Numeric extraction for comparison operators
  const numericExtract =
    dialect === "sqlite"
      ? sql`CAST(json_extract(${propertiesCol}, ${jsonPath}) AS REAL)`
      : sql`(${propertiesCol}::json->>${path})::numeric`;

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
      return sql`${extract} LIKE ${"%" + escapeLike(String(value)) + "%"}`;
    case "starts_with":
      return sql`${extract} LIKE ${escapeLike(String(value)) + "%"}`;
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
 */
export function filterToSqlConditions(
  expr: FilterExpression,
  dialect: SqlDialect,
  table: ItemsTableRef,
): SQL[] {
  return expr.conditions.map((c) => conditionToSql(c, dialect, table));
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

  // tags
  return tagsFieldRawSql(tableAlias, op, value, dialect, params, paramIdx);
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
      return { fragment: `${col} LIKE ${p}`, paramIdx: idx + 1 };
    }
    case "starts_with": {
      params.push(escapeLike(String(value)) + "%");
      return { fragment: `${col} LIKE ${p}`, paramIdx: idx + 1 };
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

  // Postgres: properties::json->>'path'
  const pathPlaceholder = placeholder(dialect, idx);
  params.push(path);
  idx++;
  const extract = `${alias}.properties::json->>${pathPlaceholder}`;
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
      return { fragment: `${extract} LIKE ${p}`, paramIdx: idx + 1 };
    }
    case "starts_with": {
      params.push(escapeLike(String(value)) + "%");
      return { fragment: `${extract} LIKE ${p}`, paramIdx: idx + 1 };
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
 * @returns The SQL clause, parameter values, and next parameter index
 */
export function filterToRawSql(
  expr: FilterExpression,
  dialect: SqlDialect,
  tableAlias: string,
  startParamIdx = 1,
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
