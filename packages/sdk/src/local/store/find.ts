import { isSubtypeOf, type Item, type ItemState } from "@withmarfa/shared";
import type { OutboxLayer } from "./outbox.js";
import type { SearchIndexLayer } from "./search.js";
import type { ServerStateLayer } from "./server-state.js";
import type { VisibleLayer } from "./visible.js";

/** The server's ceiling on a page of results, mirrored so an app moving
 *  between the two surfaces meets one number. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export interface LocalSearchFilters {
  /**
   * A type and everything under it, which is the reading `GET /items` and
   * `/search` both give this parameter. Subtypes resolve two ways because
   * the platform admits both: by declared parent, through the registry,
   * and by name, since `core.entity.place` is under `core.entity` whether
   * or not anything says so.
   */
  type?: string;
  /** Defaults to everything except trashed, which is what server search
   *  does when a caller names no state. */
  state?: ItemState;
  limit?: number;
}

export interface LocalSearchResult {
  item: Item;
  /**
   * How well it matched. Higher is better, which is the shape server
   * search returns — it is bm25's magnitude, and bm25 is negative.
   *
   * Comparable within one result set and not across the two surfaces:
   * bm25 is computed against the documents in the index, and this index
   * holds what this client has where the server's holds a whole space.
   */
  relevance_score: number;
  snippet_html: string | undefined;
}

export interface SearchLayer {
  /**
   * Search what this client holds, over the fields server search indexes.
   *
   * Resolved through visible state rather than served straight from the
   * index, so a row this client has edited and not yet sent comes back as
   * the person sees it, and a row whose delete is queued does not come
   * back at all.
   */
  find(
    query: string,
    filters?: LocalSearchFilters,
  ): Promise<LocalSearchResult[]>;
  /** Rebuild the index from what the store holds. Answers how many items
   *  were written. */
  rebuild(): Promise<number>;
}

export interface SearchDeps {
  index: SearchIndexLayer;
  visible: VisibleLayer;
  server: ServerStateLayer;
  outbox: OutboxLayer;
  spaceId: string | null;
}

export function createSearchLayer(deps: SearchDeps): SearchLayer {
  const { index, visible, spaceId } = deps;

  const inSubtree = (candidate: string, wanted: string): boolean =>
    candidate === wanted ||
    candidate.startsWith(`${wanted}.`) ||
    isSubtypeOf(candidate, wanted, spaceId);

  return {
    find: async (query, filters) => {
      const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      // Over-read, because the filters below are applied after the match
      // and every row they drop is a result the caller asked for and did
      // not get. The index is this client's own corpus rather than a
      // space's, so reading a page's worth of spare rows is cheap.
      const hits = await index.match(query, Math.min(limit * 4, MAX_LIMIT * 4));

      const results: LocalSearchResult[] = [];
      for (const hit of hits) {
        if (results.length >= limit) break;
        const item = await visible.getItem(hit.itemId);
        // Gone from visible state: a delete this client has queued, or a
        // row an event removed between the match and this read. The index
        // is caught up on the next write to it either way, and returning a
        // row the person cannot see would be worse than one fewer result.
        if (item === undefined) continue;
        if (filters?.state === undefined) {
          if (item.state === "trashed") continue;
        } else if (item.state !== filters.state) continue;
        if (
          filters?.type !== undefined &&
          !inSubtree(item.type, filters.type)
        ) {
          continue;
        }
        results.push({
          item,
          relevance_score: Math.abs(hit.rank),
          snippet_html: hit.snippet,
        });
      }
      return results;
    },

    rebuild: async () => {
      await index.clear();
      // Visible state rather than server state, so a row this client
      // created offline is findable before it has ever been sent. An index
      // built from server state alone would go quiet on exactly the writes
      // a local store exists to keep.
      const items = await visible.listItems();
      for (const item of items) await index.put(item, spaceId);
      return items.length;
    },
  };
}
