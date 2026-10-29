import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  ErrorCode,
  MarfaError,
  declaredDescendants,
  parseFilter,
  type SearchResult,
} from "@withmarfa/shared";
import type {
  SearchSortField,
  SearchStore,
  SearchFilters,
} from "../interface.js";
import { normalizeTimeBound, parseSortField } from "../interface.js";
import { buildPropertySortExpr } from "../property-sort.js";
import {
  filterToSqlConditions,
  notSystemTypeSql,
  sourceColumnSql,
  sourceFilterToSql,
  typeFilterSql,
  typeSubtreeSql,
} from "../filter-sql.js";
import { items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { rowToItem, rowToMetadata, type ItemRow } from "./helpers.js";
// What text reaches the index is decided in `search-text.ts`, not here, so
// a change to what is indexed is one edit rather than one per writer.
import { extractSearchableText, searchableShape } from "../search-text.js";

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

/**
 * FTS5 puts these private-use characters around each match in place of the
 * tags, so the excerpt is escaped whole before they become `<mark>` and
 * `</mark>`. A row's own text can hold them as well, so each opens only a
 * closed mark and closes only an open one.
 */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The excerpt FTS5 cut, as HTML whose only markup is `<mark>` around matches. */
export function snippetHtml(excerpt: string): string {
  let html = "";
  let open = false;
  for (const character of excerpt) {
    if (character === MARK_OPEN) {
      if (!open) html += "<mark>";
      open = true;
    } else if (character === MARK_CLOSE) {
      if (open) html += "</mark>";
      open = false;
    } else {
      html += HTML_ESCAPES[character] ?? character;
    }
  }
  return open ? `${html}</mark>` : html;
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
        (SELECT group_concat(value, ' ')
           FROM (SELECT je.value AS value
                   FROM metadata m, json_each(m.tags) je
                  WHERE m.item_id = ${itemId}
                  ORDER BY je.value)),
        ''
      )
    )
  `);
}

/**
 * What each of `typeId` and the types that inherit from it contributes to the
 * index, apart from any row. Take it before a change to the registry and give
 * it to `reindexChangedTypes` after. A type whose chain cannot be resolved
 * has no shape to compare, and one that stays so is left as it is, since it
 * cannot index a write either and correcting it is the way back.
 */
export function indexShapes(typeId: string): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const type of [typeId, ...declaredDescendants(typeId)]) {
    try {
      shapes.set(type, searchableShape(type));
    } catch (error) {
      if (
        !(error instanceof MarfaError) ||
        error.code !== ErrorCode.TYPE_CHAIN_UNRESOLVABLE
      )
        throw error;
      shapes.set(type, "unresolvable");
    }
  }
  return shapes;
}

/**
 * Indexes again, under the registry as it now stands, the rows of each of
 * `typeId` and the types that inherit from it whose shape differs from
 * `before`. A row's indexed text is decided when it is written, so a change
 * to a type's fields leaves the rows already stored answering by the old
 * ones until this runs. A change that leaves the shape alone, a label or a
 * description, costs nothing. Call it inside the transaction that made the
 * change, after the registry holds it.
 *
 * A trashed row is not in the index and stays out of it.
 */
export async function reindexChangedTypes(
  db: Executor,
  typeId: string,
  before: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [type, shape] of indexShapes(typeId)) {
    if (before.get(type) === shape) continue;
    const rows = await db.all<{ id: string; properties: string }>(sql`
      SELECT id, json(properties) AS properties FROM items
      WHERE type = ${type} AND state <> 'trashed'
    `);
    for (const row of rows) {
      const properties = JSON.parse(row.properties) as Record<string, unknown>;
      await replaceIndexRow(
        db,
        row.id,
        extractSearchableText(properties, type),
      );
    }
  }
}

/**
 * The ORDER BY of a search. Every ordering ends in the item ID, so a page
 * boundary falls in the same place on each read.
 *
 * Relevance puts the best match first when descending, and BM25 scores the
 * best match lowest. A system column breaks ties by ID in the direction of
 * the sort, as the item listing does. A property puts the rows without a
 * scalar there last in either direction, with ties by ID ascending.
 */
function searchOrder(
  columns: Record<
    "created_at" | "updated_at" | "occurred_at" | "properties",
    SQLWrapper
  >,
  sort: SearchSortField | undefined,
  descending: boolean,
): SQL {
  if (sort === undefined || sort === "relevance") {
    return descending ? sql`rank, i.id` : sql`rank DESC, i.id`;
  }
  const target = parseSortField(sort);
  const direction = descending ? sql`DESC` : sql`ASC`;
  if (target.kind === "property") {
    const value = buildPropertySortExpr(columns.properties, target.field);
    return sql`(${value}) IS NULL, ${value} ${direction}, i.id`;
  }
  const column = columns[target.column];
  return sql`${column} ${direction}, i.id ${direction}`;
}

export class SqliteSearchStore implements SearchStore {
  constructor(private db: DrizzleDb) {}

  async index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId: string,
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
      UPDATE items_fts SET tags = COALESCE(
        (SELECT group_concat(value, ' ')
           FROM (SELECT value FROM json_each(${JSON.stringify(tags)}) ORDER BY value)),
        ''
      )
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
    const i = alias(items, "i");
    const conditions: SQL[] = [];

    if (filters.state) {
      conditions.push(sql`${i.state} = ${filters.state}`);
    } else if (!filters.all_states) {
      // The same default the listing grammar gives, because a search that
      // answered rows a listing hides is two answers to one question.
      conditions.push(sql`${i.state} = 'active'`);
    }

    // Subtree, not an exact identifier: the same reading `GET /items` gives
    // the parameter, through the same compiler.
    const typeClause = filters.type
      ? typeSubtreeSql(i.type, filters.type)
      : undefined;
    if (typeClause) conditions.push(typeClause);

    if (filters.tier !== undefined) {
      conditions.push(sql`${i.tier} = ${filters.tier}`);
    }

    if (filters.exclude_system_types) {
      conditions.push(notSystemTypeSql(i.type));
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
      conditions.push(
        sql`COALESCE(${i.occurred_at}, ${i.created_at}) > ${occurredAfter}`,
      );
    }
    const occurredBefore = normalizeTimeBound(
      filters.occurred_before,
      "occurred_before",
    );
    if (occurredBefore !== undefined) {
      conditions.push(
        sql`COALESCE(${i.occurred_at}, ${i.created_at}) < ${occurredBefore}`,
      );
    }

    if (filters.source) {
      conditions.push(sql`${sourceColumnSql(i.source)} = ${filters.source}`);
    }

    // The item store's twins: `updated_at` at or after the lower bound,
    // before the upper, each normalized to the stored width.
    const updatedAfter = normalizeTimeBound(
      filters.updated_after,
      "updated_after",
    );
    if (updatedAfter !== undefined) {
      conditions.push(sql`${i.updated_at} >= ${updatedAfter}`);
    }
    const updatedBefore = normalizeTimeBound(
      filters.updated_before,
      "updated_before",
    );
    if (updatedBefore !== undefined) {
      conditions.push(sql`${i.updated_at} < ${updatedBefore}`);
    }

    // Items must have ALL specified tags (AND semantics).
    for (const tag of filters.tags ?? []) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${tag})`,
      );
    }

    const readable = typeFilterSql(i.type, {
      allowed: filters.allowed_types,
      excluded: filters.excluded_types ?? [],
    });
    if (readable) conditions.push(readable);

    const sourceLever = sourceFilterToSql(
      filters.source_filter,
      i.type,
      i.source,
    );
    if (sourceLever) conditions.push(sourceLever);

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const terms = filterToSqlConditions(expr, i, {
        types: filters.readable_sources,
        source_filter: filters.source_filter,
      });
      conditions.push(
        sql`(${sql.join(terms, expr.logical === "OR" ? sql` OR ` : sql` AND `)})`,
      );
    }

    const descending = (filters.direction ?? "desc") === "desc";
    const orderBy = searchOrder(i, filters.sort, descending);

    const statement = sql`
      SELECT
        snippet(items_fts, -1, ${sql.raw(`'${MARK_OPEN}', '${MARK_CLOSE}'`)}, '...', 32) AS snippet,
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
      WHERE items_fts MATCH ${escapedQuery}
        ${sql.join(
          conditions.map((condition) => sql`AND ${condition}`),
          sql` `,
        )}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const rows = await this.db.all<Record<string, unknown>>(statement);

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
      snippet_html:
        snippetHtml((row.snippet as string | null) ?? "") || undefined,
    }));
  }
}
