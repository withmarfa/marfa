import {
  parseFilter,
  getSearchableStringFields,
  type SearchResult,
} from "@mymehq/shared";
import type { SearchStore, SearchFilters } from "../interface.js";
import { filterToRawSql } from "../filter-sql.js";
import type { RawDb } from "./connection.js";
import { rowToItem, rowToMetadata } from "./helpers.js";
import type { items } from "./schema.js";

// Fields to extract from properties for full-text indexing
const FTS_FIELDS = ["title", "body", "description", "name"] as const;

function extractSearchableText(
  properties: Record<string, unknown>,
  typeId?: string,
): {
  title: string;
  body: string;
  description: string;
  name: string;
  extra: string;
} {
  const result: Record<string, string> = {};
  for (const field of FTS_FIELDS) {
    const value = properties[field];
    result[field] = typeof value === "string" ? value : "";
  }
  // Concatenate custom string fields for the extra column
  const extraFields = typeId ? getSearchableStringFields(typeId) : [];
  const extraParts: string[] = [];
  for (const field of extraFields) {
    const value = properties[field];
    if (typeof value === "string" && value) {
      extraParts.push(value);
    }
  }
  result.extra = extraParts.join(" ");
  return result as {
    title: string;
    body: string;
    description: string;
    name: string;
    extra: string;
  };
}

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
  constructor(private raw: RawDb) {}

  async index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
  ): Promise<void> {
    this.indexSync(itemId, properties, typeId);
  }

  async remove(itemId: string): Promise<void> {
    this.removeSync(itemId);
  }

  /** Synchronous version for use within SQLite transactions. */
  indexSync(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
  ): void {
    const text = extractSearchableText(properties, typeId);
    this.raw
      .prepare(
        `INSERT INTO items_fts(item_id, title, body, description, name, extra)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        text.title,
        text.body,
        text.description,
        text.name,
        text.extra,
      );
  }

  /** Synchronous version for use within SQLite transactions. */
  removeSync(itemId: string): void {
    this.raw.prepare("DELETE FROM items_fts WHERE item_id = ?").run(itemId);
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

    // Default: exclude trashed
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

    // Tags filter — items must have ALL specified tags. Uses the same
    // json_each pattern as /items.
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(
          "AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ?)",
        );
        params.push(tag);
      }
    }

    // Type permission filtering
    if (filters.allowed_types) {
      const typeClauses = filters.allowed_types.map((pattern) => {
        if (pattern === "*") return "1=1";
        if (pattern.endsWith(".*")) {
          params.push(pattern.slice(0, -1) + "%");
          return "i.type LIKE ?";
        }
        params.push(pattern);
        return "i.type = ?";
      });
      if (typeClauses.length > 0) {
        conditions.push(`AND (${typeClauses.join(" OR ")})`);
      }
    }

    // Advanced query language filter
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
        i.timestamp, i.source, i.source_id, i.origin, i.version,
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

    const rows = this.raw.prepare(rawSql).all(...params) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => ({
      // tier is a plain text column; rowToItem normalizes the value.
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
      snippet: (row.snippet as string) || undefined,
    }));
  }
}
