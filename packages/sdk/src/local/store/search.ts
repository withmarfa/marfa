import { sql } from "drizzle-orm";
import {
  getSearchableStringFields,
  isFieldSearchableExcluded,
  type Item,
} from "@withmarfa/shared";
import type { Client } from "@libsql/client";
import type { Executor } from "./executor.js";

/**
 * The offline index, and its relation to server search.
 *
 * **Same fields, ranking may differ.** The columns below are the server's
 * SQLite index column for column, and the text that goes into them is
 * chosen by the same two questions the server asks — is this one of the
 * four core fields, and is this a string field the type declares that has
 * not opted out. So an item server search finds by a display-hint field is
 * an item this finds, which is rule 15's whole claim.
 *
 * Ranking is where they are allowed to part. Both order by `bm25`, and
 * bm25 is computed against the documents in the index: the server's index
 * holds a whole space and this one holds what this client has, so the same
 * term is rarer or commoner on the two sides and the scores differ. An
 * engine that promised identical ordering would be promising to replicate
 * the whole corpus, which is not what a local store is.
 *
 * A virtual table, so drizzle's schema cannot express it and its migration
 * cannot be generated. It is created on the raw client instead, which is
 * what the server does with its own for the same reason.
 */
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id,
  title,
  body,
  description,
  name,
  extra,
  tokenize='porter unicode61'
);
`;

/** The four the index gives their own column, which is what lets a caller
 *  see which field matched. Everything else shares `extra`. */
const CORE_FIELDS = ["title", "body", "description", "name"] as const;
type CoreField = (typeof CORE_FIELDS)[number];

/** `snippet()`'s column index for `title`. Column 0 is `item_id`. */
const SNIPPET_COLUMN = 1;

export interface SearchableText {
  title: string;
  body: string;
  description: string;
  name: string;
  /** Every other searchable string field the type declares, space-joined
   *  in the registry's own traversal order. */
  extra: string;
}

/**
 * What text an item contributes to the index.
 *
 * Deliberately the server's rule rather than a local invention. A core
 * field is a candidate unless the type opts it out; everything else is any
 * string field the type declares that has not opted out. A type's display
 * hints name fields on that type, so they land in these columns without
 * being singled out — and indexing only the hint fields would be the one
 * mistake rule 15 forbids, because it would find fewer items than server
 * search rather than the same ones.
 */
export function searchableText(
  properties: Record<string, unknown>,
  typeId: string | undefined,
  spaceId: string | null,
): SearchableText {
  const core: Record<CoreField, string> = {
    title: "",
    body: "",
    description: "",
    name: "",
  };
  for (const field of CORE_FIELDS) {
    if (
      typeId !== undefined &&
      isFieldSearchableExcluded(typeId, field, spaceId)
    ) {
      continue;
    }
    const value = properties[field];
    if (typeof value === "string") core[field] = value;
  }

  const extra: string[] = [];
  for (const field of typeId === undefined
    ? []
    : getSearchableStringFields(typeId, spaceId)) {
    const value = properties[field];
    if (typeof value === "string" && value) extra.push(value);
  }

  return { ...core, extra: extra.join(" ") };
}

/**
 * Turn what a person typed into an FTS5 query.
 *
 * The server's rule, restated because it is server-internal: a quoted
 * string is a phrase, and otherwise each token is quoted — so a hyphen is
 * a character rather than FTS5's NOT — with a prefix wildcard on the last
 * one, which is what makes a search feel live as somebody types.
 */
export function buildFtsQuery(query: string): string {
  if (query.startsWith('"') && query.endsWith('"') && query.length > 2) {
    return `"${query.slice(1, -1).replace(/"/g, '""')}"`;
  }
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens
    .map((token, index) => {
      const escaped = `"${token.replace(/"/g, '""')}"`;
      return index === tokens.length - 1 ? `${escaped}*` : escaped;
    })
    .join(" ");
}

/** One row the index matched, before it is resolved to an item. */
export interface SearchHit {
  itemId: string;
  /** bm25, as FTS5 reports it: lower is a better match. */
  rank: number;
  snippet: string | undefined;
}

export interface SearchIndexLayer {
  /** Write this item's text, replacing whatever was there. */
  put(item: Item, spaceId: string | null): Promise<void>;
  remove(itemId: string): Promise<void>;
  /** Empty the index. Paired with a walk of visible state to refill it. */
  clear(): Promise<void>;
  match(query: string, limit: number): Promise<SearchHit[]>;
  count(): Promise<number>;
}

export function createSearchIndexLayer(exec: Executor): SearchIndexLayer {
  return {
    put: async (item, spaceId) => {
      const text = searchableText(item.properties, item.type, spaceId);
      // Replace rather than append. FTS5 has no upsert, and an index that
      // only ever inserted would hold one row per edit — every stale one
      // still matching, so a term a person removed would go on finding the
      // item for ever.
      await exec.run(sql`DELETE FROM items_fts WHERE item_id = ${item.id}`);
      await exec.run(sql`
        INSERT INTO items_fts(item_id, title, body, description, name, extra)
        VALUES (${item.id}, ${text.title}, ${text.body}, ${text.description}, ${text.name}, ${text.extra})
      `);
    },

    remove: async (itemId) => {
      await exec.run(sql`DELETE FROM items_fts WHERE item_id = ${itemId}`);
    },

    clear: async () => {
      await exec.run(sql`DELETE FROM items_fts`);
    },

    match: async (query, limit) => {
      const rows = await exec.all<{
        item_id: string;
        rank: number;
        snippet: string | null;
      }>(sql`
        SELECT
          item_id,
          bm25(items_fts) AS rank,
          snippet(items_fts, ${SNIPPET_COLUMN}, '<mark>', '</mark>', '...', 32) AS snippet
        FROM items_fts
        WHERE items_fts MATCH ${buildFtsQuery(query)}
        ORDER BY rank
        LIMIT ${limit}
      `);
      return rows.map((row) => ({
        itemId: row.item_id,
        rank: row.rank,
        snippet: row.snippet ?? undefined,
      }));
    },

    count: async () => {
      const rows = await exec.all<{ total: number }>(
        sql`SELECT count(*) AS total FROM items_fts`,
      );
      return rows[0]?.total ?? 0;
    },
  };
}

/**
 * Make sure the store has an index of the shape this build expects, and
 * say whether it had to be built from nothing.
 *
 * Drizzle's migrator cannot carry a virtual table, so this runs on the raw
 * client at open, exactly as the server does. Two cases produce an empty
 * index that has to be refilled: a store written before this build, which
 * has no table at all, and a store whose table is missing a column — FTS5
 * has no `ALTER TABLE`, so the only repair is to drop and rebuild.
 *
 * The distinction matters because an empty index is silent. A search over
 * one returns nothing and looks exactly like a search that matched
 * nothing, so a store upgraded without a refill would go on answering
 * "no results" for its whole corpus with nothing reporting it.
 */
export async function ensureSearchIndex(raw: Client): Promise<boolean> {
  const existing = await raw.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items_fts'",
  );
  let fresh = existing.rows.length === 0;

  if (!fresh) {
    try {
      await raw.execute("SELECT extra FROM items_fts LIMIT 0");
    } catch {
      await raw.executeMultiple("DROP TABLE IF EXISTS items_fts");
      fresh = true;
    }
  }

  // `executeMultiple` rather than `execute`, which is the door the server
  // uses for the same statement: a virtual-table create is DDL drizzle has
  // no expression for.
  await raw.executeMultiple(CREATE_FTS);
  return fresh;
}
