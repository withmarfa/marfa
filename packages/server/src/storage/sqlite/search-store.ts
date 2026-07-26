import { sql } from "drizzle-orm";
import {
  parseFilter,
  typePatternToSql,
  type SearchResult,
} from "@withmarfa/shared";
import type { SearchStore, SearchFilters } from "../interface.js";
import { filterToRawSql } from "../filter-sql.js";
import type { DrizzleDb } from "./connection.js";
import { rowToItem, rowToMetadata } from "./helpers.js";
import type { items } from "./schema.js";
// Shared FTS text extractor — both dialects consult this so the indexed
// surface is identical (same fields, same `searchable: false` opt-outs,
// same long-tail ordering).
import { extractSearchableText } from "../search-text.js";

/**
 * Build an FTS5 query with prefix matching on the last token.
 * Quoted input ("exact phrase") is treated as a phrase match.
 * Unquoted input tokenizes, quotes each token (to prevent hyphen-as-NOT),
 * and appends * to the last token for prefix matching.
 */
function buildFtsQuery(query: string): string {
  if (query.startsWith('"') && query.endsWith('"') && query.length > 2) {
    return `"${query.slice(1, -1).replace(/"/g, '""')}"`;
  }
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens
    .map((token, i) => {
      const escaped = `"${token.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${escaped}*` : escaped;
    })
    .join(" ");
}

export class SqliteSearchStore implements SearchStore {
  constructor(private db: DrizzleDb) {}

  async index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
    tenantId?: string,
  ): Promise<void> {
    const text = extractSearchableText(properties, typeId, tenantId);
    await this.db.run(sql`
      INSERT INTO items_fts(item_id, title, body, description, name, extra)
      VALUES (${itemId}, ${text.title}, ${text.body}, ${text.description}, ${text.name}, ${text.extra})
    `);
  }

  async remove(itemId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM items_fts WHERE item_id = ${itemId}`);
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    const escapedQuery = buildFtsQuery(query);
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[] = [escapedQuery];

    if (filters.tenantId) {
      conditions.push("AND i.tenant_id = ?");
      params.push(filters.tenantId);
    }

    if (filters.state) {
      conditions.push("AND i.state = ?");
      params.push(filters.state);
    } else {
      conditions.push("AND i.state != 'trashed'");
    }

    if (filters.type) {
      conditions.push("AND i.type = ?");
      params.push(filters.type);
    }

    if (filters.tier !== undefined) {
      conditions.push("AND i.tier = ?");
      params.push(filters.tier);
    }

    if (filters.sources && filters.sources.length > 0) {
      const placeholders = filters.sources.map(() => "?").join(", ");
      conditions.push(`AND i.source IN (${placeholders})`);
      params.push(...filters.sources);
    }

    if (filters.exclude_system_types) {
      conditions.push("AND i.type NOT LIKE 'system.%'");
    }

    // Items must have ALL specified tags (AND semantics).
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(
          "AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ?)",
        );
        params.push(tag);
      }
    }

    if (filters.allowed_types) {
      // Empty allowed_types means "no readable types" — see
      // SqliteItemStore.list. Must filter to zero rows.
      if (filters.allowed_types.length === 0) {
        conditions.push("AND 1=0");
      } else {
        const typeClauses = filters.allowed_types.map((pattern) => {
          const { global, exact, descendantPattern } =
            typePatternToSql(pattern);
          if (global) return "1=1";
          if (!exact) return "1=0";
          if (!descendantPattern) {
            params.push(exact);
            return "i.type = ?";
          }
          params.push(exact, descendantPattern);
          return "(i.type = ? OR i.type LIKE ? ESCAPE '\\')";
        });
        conditions.push(`AND (${typeClauses.join(" OR ")})`);
      }
    }

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const { clause, params: filterParams } = filterToRawSql(
        expr,
        "sqlite",
        "i",
        1,
        filters.tenantId,
      );
      conditions.push(`AND ${clause}`);
      params.push(...filterParams);
    }

    params.push(limit);
    params.push(offset);

    const rawSql = `
      SELECT
        fts.item_id AS fts_item_id,
        snippet(items_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet,
        bm25(items_fts) AS rank,
        i.id, i.type, i.state, i.properties, i.created_at, i.updated_at,
        i.timestamp, i.source, i.source_id, i.version,
        i.schema_version, i.device, i.tier,
        i.capture_latitude, i.capture_longitude,
        m.item_id AS meta_item_id, m.tags, m.extensions
      FROM items_fts fts
      JOIN items i ON i.id = fts.item_id
      LEFT JOIN metadata m ON m.item_id = i.id
      WHERE items_fts MATCH ?
        ${conditions.join("\n        ")}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    // Build the prepared SQL by stitching `?`-split fragments together with
    // drizzle's parameter binding for each inline value. Drizzle's `sql`
    // template binds JS values to libsql's positional `?` parameters; we
    // can't pass a pre-formatted SQL string with `?`s through `sql.raw`
    // because raw fragments don't bind params.
    const fragments = rawSql.split("?");
    const builder = sql.empty();
    for (let i = 0; i < fragments.length; i++) {
      builder.append(sql.raw(fragments[i] ?? ""));
      if (i < fragments.length - 1) {
        builder.append(sql`${params[i]}`);
      }
    }

    const rows = await this.db.all<Record<string, unknown>>(builder);

    return rows.map((row) => ({
      item: rowToItem({
        ...row,
      } as unknown as typeof items.$inferSelect),
      metadata: rowToMetadata({
        item_id: row.id as string,
        tags: (row.tags as string | null) ?? "[]",
        extensions: (row.extensions as string | null) ?? "{}",
      }),
      relevance_score: Math.abs(row.rank as number),
      snippet_html: (row.snippet as string) || undefined,
    }));
  }
}
