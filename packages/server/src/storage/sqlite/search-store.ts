import { sql } from "drizzle-orm";
import {
  MAX_RESOLUTION_DEPTH,
  getTypeSchema,
  listTypes,
  parseFilter,
  typePatternToSql,
  typeFilterTerms,
  typeSubtreeToSql,
  type SearchResult,
} from "@withmarfa/shared";
import type { SearchStore, SearchFilters } from "../interface.js";
import { normalizeTimeBound } from "../interface.js";
import { filterToRawSql, sourceFilterToRawSql } from "../filter-sql.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { rowToItem, rowToMetadata, type ItemRow } from "./helpers.js";
// What text reaches the index is decided in `search-text.ts`, not here, so
// a change to what is indexed is one edit rather than one per writer.
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

type Executor = DrizzleDb | SqliteTxContext;

/**
 * Replaces an item's row in the full-text index. SQL carries the key
 * throughout because SQLite integers can exceed JavaScript's exact-number
 * range.
 */
async function replaceIndexRow(
  db: Executor,
  itemId: string,
  text: ReturnType<typeof extractSearchableText>,
): Promise<void> {
  await db.run(sql`
    INSERT INTO item_search_keys(item_id) VALUES (${itemId})
    ON CONFLICT(item_id) DO NOTHING
  `);
  await db.run(sql`
    INSERT OR REPLACE INTO items_fts(rowid, title, body, description, name, extra, tags)
    VALUES (
      (SELECT seq FROM item_search_keys WHERE item_id = ${itemId}),
      ${text.title}, ${text.body}, ${text.description}, ${text.name}, ${text.extra},
      COALESCE(
        (SELECT group_concat(je.value, ' ')
           FROM metadata m, json_each(m.tags) je
          WHERE m.item_id = ${itemId}),
        ''
      )
    )
  `);
}

/**
 * Whether `id` reaches `root` through declared parents. Unlike
 * `isSubtypeOf` it never throws: a type whose chain loops or runs too deep
 * simply does not reach it, so one broken type cannot stop another's change.
 */
function inheritsFrom(id: string, root: string): boolean {
  const seen = new Set<string>();
  let current = getTypeSchema(id)?.parent;
  while (current && !seen.has(current) && seen.size < MAX_RESOLUTION_DEPTH) {
    if (current === root) return true;
    seen.add(current);
    current = getTypeSchema(current)?.parent;
  }
  return false;
}

/**
 * Indexes again, under the registry as it now stands, every row of `typeId`
 * and of each type that inherits from it. A row's indexed text is decided
 * when it is written, so a change to a type's fields leaves the rows already
 * stored answering by the old ones until this runs. Call it after the change
 * is in the registry and inside the transaction that made it.
 *
 * A trashed row is not in the index and stays out of it.
 */
export async function reindexTypeRows(
  db: Executor,
  typeId: string,
): Promise<void> {
  const affected = [
    typeId,
    ...listTypes()
      .map((schema) => schema.id)
      .filter((id) => id !== typeId && inheritsFrom(id, typeId)),
  ];
  for (const type of affected) {
    const rows = await db.all<{ id: string; properties: string }>(sql`
      SELECT id, json(properties) AS properties FROM items
      WHERE type = ${type} AND state <> 'trashed'
    `);
    for (const row of rows) {
      const properties = JSON.parse(row.properties) as Record<string, unknown>;
      const text = extractSearchableText(properties, type);
      await replaceIndexRow(db, row.id, text);
    }
  }
}

export class SqliteSearchStore implements SearchStore {
  constructor(private db: DrizzleDb) {}

  async index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
  ): Promise<void> {
    const text = extractSearchableText(properties, typeId);
    // Keep the key and FTS replacement atomic even when called without an
    // enclosing item transaction.
    await this.db.transaction((tx) => replaceIndexRow(tx, itemId, text));
  }

  async setTags(itemId: string, tags: readonly string[]): Promise<void> {
    // An update rather than a delete and re-insert: the text columns are
    // not at hand here, and an FTS5 table with its own content takes one.
    await this.db.run(sql`
      UPDATE items_fts SET tags = ${tags.join(" ")}
      WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = ${itemId})
    `);
  }

  async remove(itemId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(sql`
        DELETE FROM items_fts
        WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = ${itemId})
      `);
      await tx.run(sql`DELETE FROM item_search_keys WHERE item_id = ${itemId}`);
    });
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    const escapedQuery = buildFtsQuery(query);
    // The route bounds the page and asks for one row past it to learn
    // whether another follows, so the store takes the number it is given.
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[] = [escapedQuery];

    if (filters.state) {
      conditions.push("AND i.state = ?");
      params.push(filters.state);
    } else if (!filters.all_states) {
      // The same default the listing grammar gives, because a search that
      // answered rows a listing hides is two answers to one question.
      conditions.push("AND i.state = 'active'");
    }

    if (filters.type) {
      // Subtree, not an exact identifier — the same reading `GET /items`
      // gives the parameter. `core.entity` and `core.entity.*` both mean
      // the type and everything under it, by name prefix and by declared
      // parent, so a caller who narrows a search the way they narrow a
      // listing gets the same set.
      const { global, exact, descendantPattern, extraTypes } = typeSubtreeToSql(
        filters.type,
      );
      if (!global && exact && descendantPattern) {
        const clauses = ["i.type = ?", "i.type LIKE ? ESCAPE '\\'"];
        params.push(exact, descendantPattern);
        if (extraTypes.length > 0) {
          clauses.push(`i.type IN (${extraTypes.map(() => "?").join(", ")})`);
          params.push(...extraTypes);
        }
        conditions.push(`AND (${clauses.join(" OR ")})`);
      }
    }

    if (filters.tier !== undefined) {
      conditions.push("AND i.tier = ?");
      params.push(filters.tier);
    }

    if (filters.exclude_system_types) {
      conditions.push("AND i.type NOT LIKE 'system.%'");
    }

    // The item store's twin, and deliberately the same expression:
    // `COALESCE(occurred_at, created_at)`, exclusive at both ends,
    // normalized to the stored width before a lexical text comparison
    // sees it.
    const occurredAfter = normalizeTimeBound(
      filters.occurred_after,
      "occurred_after",
    );
    if (occurredAfter !== undefined) {
      conditions.push("AND COALESCE(i.occurred_at, i.created_at) > ?");
      params.push(occurredAfter);
    }
    const occurredBefore = normalizeTimeBound(
      filters.occurred_before,
      "occurred_before",
    );
    if (occurredBefore !== undefined) {
      conditions.push("AND COALESCE(i.occurred_at, i.created_at) < ?");
      params.push(occurredBefore);
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
        const clauseFor = (pattern: string): string => {
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
        };
        const typeClauses = typeFilterTerms(
          filters.allowed_types,
          filters.excluded_types ?? [],
        ).map(({ pattern, minus }) => {
          const granted = clauseFor(pattern);
          if (minus.length === 0) return granted;
          return `(${granted} AND NOT (${minus.map(clauseFor).join(" OR ")}))`;
        });
        conditions.push(`AND (${typeClauses.join(" OR ")})`);
      }
    }

    const sourceLever = sourceFilterToRawSql(filters.source_filter, "i");
    if (sourceLever) {
      conditions.push(`AND ${sourceLever.clause}`);
      params.push(...sourceLever.params);
    }

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const { clause, params: filterParams } = filterToRawSql(
        expr,
        "i",
        filters.readable_sources,
      );
      conditions.push(`AND ${clause}`);
      params.push(...filterParams);
    }

    params.push(limit);
    params.push(offset);

    const rawSql = `
      SELECT
        snippet(items_fts, -1, '<mark>', '</mark>', '...', 32) AS snippet,
        bm25(items_fts) AS rank,
        i.id, i.type, i.state, json(i.properties) AS properties,
        i.created_at, i.updated_at,
        i.occurred_at, i.source, i.source_id, i.version,
        i.schema_version, i.tier,
        i.capture_latitude, i.capture_longitude,
        m.item_id AS meta_item_id, m.tags, m.extensions
      FROM items_fts fts
      JOIN item_search_keys k ON k.seq = fts.rowid
      JOIN items i ON i.id = k.item_id
      LEFT JOIN metadata m ON m.item_id = i.id
      WHERE items_fts MATCH ?
        ${conditions.join("\n        ")}
      ORDER BY rank, i.id
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
      } as unknown as ItemRow),
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
