import type { SearchResult } from "@myme/shared";
import type { SearchStore, SearchFilters } from "../interface.js";
import type { RawDb } from "./connection.js";
import { rowToItem, rowToMetadata } from "./helpers.js";
import type { items } from "./schema.js";

// Fields to extract from properties for full-text indexing
const FTS_FIELDS = ["title", "body", "description", "name"] as const;

function extractSearchableText(
  properties: Record<string, unknown>,
): Record<(typeof FTS_FIELDS)[number], string> {
  const result: Record<string, string> = {};
  for (const field of FTS_FIELDS) {
    const value = properties[field];
    result[field] = typeof value === "string" ? value : "";
  }
  return result as Record<(typeof FTS_FIELDS)[number], string>;
}

export class SqliteSearchStore implements SearchStore {
  constructor(private raw: RawDb) {}

  index(itemId: string, properties: Record<string, unknown>): void {
    const text = extractSearchableText(properties);
    this.raw
      .prepare(
        `INSERT INTO items_fts(item_id, title, body, description, name)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(itemId, text.title, text.body, text.description, text.name);
  }

  remove(itemId: string): void {
    this.raw.prepare("DELETE FROM items_fts WHERE item_id = ?").run(itemId);
  }

  search(query: string, filters: SearchFilters): SearchResult[] {
    // Wrap query in double quotes for FTS5 phrase matching.
    // This prevents hyphens from being interpreted as NOT operators.
    const escapedQuery = `"${query.replace(/"/g, '""')}"`;
    const limit = Math.min(filters.limit ?? 20, 100);
    const conditions: string[] = [];
    const params: unknown[] = [escapedQuery];

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

    params.push(limit);

    const rawSql = `
      SELECT
        fts.item_id AS fts_item_id,
        snippet(items_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet,
        bm25(items_fts) AS rank,
        i.id, i.type, i.state, i.properties, i.created_at, i.updated_at,
        i.timestamp, i.source, i.source_id, i.origin, i.version,
        i.schema_version, i.device_id, i.parent_id, i.thread_id,
        i.capture_latitude, i.capture_longitude,
        m.item_id AS meta_item_id, m.tags, m.about
      FROM items_fts fts
      JOIN items i ON i.id = fts.item_id
      LEFT JOIN metadata m ON m.item_id = i.id
      WHERE items_fts MATCH ?
        ${conditions.join("\n        ")}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.raw.prepare(rawSql).all(...params) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => ({
      item: rowToItem(row as unknown as typeof items.$inferSelect),
      metadata: rowToMetadata({
        item_id: row.id as string,
        tags: (row.tags as string | null) ?? "[]",
        about: (row.about as string | null) ?? "[]",
      }),
      relevance_score: Math.abs(row.rank as number),
      snippet: (row.snippet as string) || undefined,
    }));
  }
}
