import { safeJsonParse } from "../json-utils.js";
import { parseFilter, type SearchResult } from "@withmarfa/shared";
import { sql } from "drizzle-orm";
import type { SearchStore, SearchFilters } from "../interface.js";
import { filterToRawSql } from "../filter-sql.js";
import type { PgClient, PgDb } from "./connection.js";
import { rowToItem } from "./helpers.js";
import type { items } from "./schema.js";
// Shared FTS text extractor — both dialects compute the indexable text
// the same way so the cross-dialect parity test holds.
import { extractSearchableText } from "../search-text.js";

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
  /**
   * Writes go through the request-context-aware Drizzle instance (`db`)
   * so an `index()` call inside a `db.transaction(...)` runs on the same
   * reserved connection as the parent INSERT/UPDATE. Reads (the `search`
   * method's raw SQL) use the bare client — search isn't typically nested
   * in a write transaction, and taking a fresh pool connection is fine.
   */
  constructor(
    private db: PgDb,
    private client: PgClient,
  ) {}

  /**
   * Write the materialized tsvector for an item. The text fed to
   * `to_tsvector('english', ...)` comes from the shared
   * `extractSearchableText` helper, which respects per-type
   * `searchable: false` opt-outs and produces the same field set the
   * SQLite FTS5 indexer uses. Called inside the same transaction as
   * the items INSERT/UPDATE so the row + its search vector commit
   * atomically; if the index call fails, the parent transaction rolls
   * the row back too.
   */
  async index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
    tenantId?: string,
  ): Promise<void> {
    const text = extractSearchableText(properties, typeId, tenantId);
    // Concatenate with single-space separators — same shape as the
    // backfill migration so existing rows match write-time semantics.
    const combined = [
      text.title,
      text.body,
      text.description,
      text.name,
      text.extra,
    ]
      .filter((s) => s.length > 0)
      .join(" ");
    await this.db.execute(
      sql`UPDATE items SET search_vector = to_tsvector('english', ${combined}) WHERE id = ${itemId}`,
    );
  }

  /**
   * Clear the search vector. Called when an item is hard-deleted or
   * restored from a state that excluded it from FTS. The row may already
   * be gone (cascade delete); the UPDATE no-ops in that case.
   */
  async remove(itemId: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE items SET search_vector = NULL WHERE id = ${itemId}`,
    );
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;
    const conditions: string[] = [];
    const params: (string | number | boolean)[] = [];
    let paramIdx = 1;

    const queryParam = `$${String(paramIdx++)}`;
    const { expr: tsqueryExpr, paramValue } = buildTsQueryExpr(
      query,
      queryParam,
    );
    params.push(paramValue);

    const tsvec = `i.search_vector`;

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

    if (filters.tier !== undefined) {
      params.push(filters.tier);
      conditions.push(`AND i.tier = $${String(paramIdx++)}`);
    }

    if (filters.sources && filters.sources.length > 0) {
      const placeholders = filters.sources
        .map(() => `$${String(paramIdx++)}`)
        .join(", ");
      params.push(...filters.sources);
      conditions.push(`AND i.source IN (${placeholders})`);
    }

    if (filters.exclude_system_types) {
      conditions.push(`AND i.type NOT LIKE 'system.%'`);
    }

    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        params.push(JSON.stringify([tag]));
        conditions.push(`AND m.tags::jsonb @> $${String(paramIdx++)}::jsonb`);
      }
    }

    if (filters.allowed_types) {
      // Empty allowed_types means "no readable types" — must filter to zero rows (mirrors PgItemStore.list).
      if (filters.allowed_types.length === 0) {
        conditions.push("AND 1=0");
      } else {
        const typeClauses = filters.allowed_types.map((pattern) => {
          if (pattern === "*") return "1=1";
          if (pattern.endsWith(".*")) {
            params.push(pattern.slice(0, -1) + "%");
            return `i.type LIKE $${String(paramIdx++)}`;
          }
          params.push(pattern);
          return `i.type = $${String(paramIdx++)}`;
        });
        conditions.push(`AND (${typeClauses.join(" OR ")})`);
      }
    }

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const {
        clause,
        params: filterParams,
        nextParamIdx,
      } = filterToRawSql(expr, "pg", "i", paramIdx, filters.tenantId);
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
        i.timestamp, i.source, i.source_id, i.version,
        i.schema_version, i.device, i.tier,
        i.capture_latitude, i.capture_longitude,
        m.item_id AS meta_item_id, m.tags, m.extensions,
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
        extensions: safeJsonParse<Record<string, Record<string, unknown>>>(
          (row.extensions as string | null) ?? "{}",
          {},
          "search extensions",
        ),
      },
      relevance_score: Math.abs(row.rank as number),
      snippet_html: (row.snippet as string) || undefined,
    }));
  }
}
