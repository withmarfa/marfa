import { safeJsonParse } from "../json-utils.js";
import { parseFilter, type SearchResult } from "@mymehq/shared";
import type { SearchStore, SearchFilters } from "../interface.js";
import { filterToRawSql } from "../filter-sql.js";
import type { PgClient } from "./connection.js";
import { rowToItem } from "./helpers.js";
import type { items } from "./schema.js";

/**
 * Build a Postgres tsquery function call with prefix matching on the last token.
 * Quoted input ("exact phrase") uses phraseto_tsquery for exact phrase matching.
 * Unquoted input tokenizes, joins with &, and appends :* to the last token.
 */
/**
 * Sanitize a token for use in to_tsquery — strip tsquery operators.
 */
function sanitizeTsToken(token: string): string {
  return token.replace(/[&|!():*'"\\<>]/g, "").trim();
}

function buildTsQueryExpr(
  query: string,
  queryParam: string,
): { expr: string; paramValue: string } {
  if (query.startsWith('"') && query.endsWith('"') && query.length > 2) {
    return {
      expr: `phraseto_tsquery('english', ${queryParam})`,
      paramValue: query.slice(1, -1),
    };
  }
  const tokens = query.trim().split(/\s+/).map(sanitizeTsToken).filter(Boolean);
  if (tokens.length === 0) {
    return {
      expr: `phraseto_tsquery('english', ${queryParam})`,
      paramValue: query,
    };
  }
  const tsqueryStr = tokens
    .map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t))
    .join(" & ");
  return {
    expr: `to_tsquery('english', ${queryParam})`,
    paramValue: tsqueryStr,
  };
}

export class PgSearchStore implements SearchStore {
  constructor(private client: PgClient) {}

  // No-op: Postgres computes tsvectors at query time from the properties JSON
  // column. Unlike SQLite (which maintains a separate FTS5 table), Postgres does
  // not need an explicit index step. The SearchStore interface requires these
  // methods for SQLite compatibility but they are intentionally empty here.
  async index(
    _itemId: string, // eslint-disable-line @typescript-eslint/no-unused-vars
    _properties: Record<string, unknown>, // eslint-disable-line @typescript-eslint/no-unused-vars
    _typeId?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<void> {
    // Intentionally empty — see class comment above
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async remove(_itemId: string): Promise<void> {
    // Intentionally empty — see class comment above
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    // The tsquery parameter — build prefix-aware query
    const queryParam = `$${String(paramIdx++)}`;
    const { expr: tsqueryExpr, paramValue } = buildTsQueryExpr(
      query,
      queryParam,
    );
    params.push(paramValue);

    // tsvector expression over JSON properties — includes all string values
    // via json_each_text so custom type string fields are searchable
    const tsvec = `to_tsvector('english',
      coalesce(i.properties::json->>'title','') || ' ' ||
      coalesce(i.properties::json->>'body','') || ' ' ||
      coalesce(i.properties::json->>'description','') || ' ' ||
      coalesce(i.properties::json->>'name','') || ' ' ||
      coalesce((SELECT string_agg(value, ' ') FROM json_each_text(i.properties::json)
                WHERE key NOT IN ('title','body','description','name')), '')
    )`;

    // Default: exclude trashed
    if (filters.state) {
      params.push(filters.state);
      conditions.push(`AND i.state = $${String(paramIdx++)}`);
    } else {
      conditions.push("AND i.state != 'trashed'");
    }

    if (filters.tenantId) {
      params.push(filters.tenantId);
      conditions.push(`AND i.tenant_id = $${String(paramIdx++)}`);
    }

    if (filters.type) {
      params.push(filters.type);
      conditions.push(`AND i.type = $${String(paramIdx++)}`);
    }

    // Type permission filtering
    if (filters.allowed_types) {
      const typeClauses = filters.allowed_types.map((pattern) => {
        if (pattern === "*") return "1=1";
        if (pattern.endsWith(".*")) {
          params.push(pattern.slice(0, -1) + "%");
          return `i.type LIKE $${String(paramIdx++)}`;
        }
        params.push(pattern);
        return `i.type = $${String(paramIdx++)}`;
      });
      if (typeClauses.length > 0) {
        conditions.push(`AND (${typeClauses.join(" OR ")})`);
      }
    }

    // Advanced query language filter
    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const {
        clause,
        params: filterParams,
        nextParamIdx,
      } = filterToRawSql(expr, "pg", "i", paramIdx);
      conditions.push(`AND ${clause}`);
      params.push(...(filterParams as (string | number)[]));
      paramIdx = nextParamIdx;
    }

    params.push(limit);
    const limitParam = `$${String(paramIdx++)}`;
    params.push(offset);
    const offsetParam = `$${String(paramIdx++)}`;

    const rawSql = `
      SELECT
        i.id, i.type, i.state, i.properties, i.created_at, i.updated_at,
        i.timestamp, i.source, i.source_id, i.origin, i.version,
        i.schema_version, i.device, i.parent_id, i.thread_id,
        i.capture_latitude, i.capture_longitude,
        m.item_id AS meta_item_id, m.tags, m.about, m.extensions,
        ts_rank(${tsvec}, ${tsqueryExpr}) AS rank,
        ts_headline('english',
          coalesce(i.properties::json->>'title','') || ' ' ||
          coalesce(i.properties::json->>'body','') || ' ' ||
          coalesce(i.properties::json->>'description','') || ' ' ||
          coalesce(i.properties::json->>'name',''),
          ${tsqueryExpr},
          'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=32'
        ) AS snippet
      FROM items i
      LEFT JOIN metadata m ON m.item_id = i.id
      WHERE ${tsvec} @@ ${tsqueryExpr}
        ${conditions.join("\n        ")}
      ORDER BY rank DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const rows = await this.client.unsafe(rawSql, params);

    return rows.map((row) => ({
      item: rowToItem(row as unknown as typeof items.$inferSelect),
      metadata: {
        item_id: row.id as string,
        tags: safeJsonParse<string[]>(
          (row.tags as string | null) ?? "[]",
          [],
          "search tags",
        ),
        about: safeJsonParse<string[]>(
          (row.about as string | null) ?? "[]",
          [],
          "search about",
        ),
        extensions: safeJsonParse<Record<string, Record<string, unknown>>>(
          (row.extensions as string | null) ?? "{}",
          {},
          "search extensions",
        ),
      },
      relevance_score: Math.abs(row.rank as number),
      snippet_html: (row.snippet as string) || undefined,
      snippet: (row.snippet as string) || undefined,
    }));
  }
}
