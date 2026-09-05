import { createCollection } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import type { Item } from "@withmarfa/shared";
import type { LocalStore } from "./store/index.js";

/**
 * Visible state, as a collection an interface can render.
 *
 * The store holds the whole space; this holds one type of it, which is the
 * division the two are for. A store is what survives a restart and answers
 * a question about any row; a collection is what a list is bound to, and a
 * list bound to the whole space is a list nobody asked for.
 *
 * It is fed from the **visible** layer rather than from server state, so
 * what it shows is server state with this client's queue replayed over it.
 * That is the whole reason a write appears instantly and does not blink:
 * the row a person just made is in the queue, the queue is part of the
 * projection, and nothing has to wait for the server to agree.
 *
 * `@tanstack/db` is an optional peer, so this module is only reachable
 * from a consumer that installed it.
 */

/**
 * Default ceiling on one projection.
 *
 * A collection is held in memory and rendered, so this is the size of the
 * thing being put into a view rather than the size of the store. Far above
 * any single-player type and far below what wedges a tab: a type that
 * outgrows it reports through `onError` rather than filling the page, so it
 * is found where it stopped fitting instead of in a report about a frozen
 * tab.
 */
export const DEFAULT_PROJECTION_MAX_ITEMS = 50_000;

export interface ProjectionOptions {
  store: LocalStore;
  /** Marfa type to project, e.g. `core.note`. */
  type: string;
  /**
   * Most rows this projection will hold. A walk past it stops at the
   * ceiling and reports through `onError` rather than filling the tab.
   */
  maxItems?: number;
  /** Called when a refresh could not be completed. */
  onError?: (error: unknown) => void;
}

export interface ProjectionUtils {
  /**
   * Re-read the store into the collection.
   *
   * The engine writes to the store rather than to this, so something has
   * to say when a read is worth repeating. Call it on the engine's
   * `store.changed` event, which fires after an inbound change has been
   * applied, rather than from a timer here: a projection that polled
   * would be a second scheduler beside the one the app already has, and
   * would still be wrong about when to look.
   */
  refresh: () => Promise<void>;
}

export type ProjectionCollection = Collection<Item, string, ProjectionUtils>;

/**
 * Build a collection over one type of a store's visible state.
 *
 * Read-only by design. Writes go through `store.mutations`, which enqueues
 * them in the same transaction as the local row — a collection that
 * accepted writes of its own would be a second way to make one, and the
 * two would order differently under a drain.
 */
export function createProjection(
  options: ProjectionOptions,
): ProjectionCollection {
  const {
    store,
    type,
    maxItems = DEFAULT_PROJECTION_MAX_ITEMS,
    onError,
  } = options;

  let refreshFromSync: (() => Promise<void>) | null = null;

  const collection = createCollection<Item, string, ProjectionUtils>({
    id: `marfa:local:${type}`,
    getKey: (item) => item.id,

    sync: {
      // A merge that removes a property has to reach the view: the server's
      // own merge can drop one, and the partial mode would leave the
      // removed key sitting there, because it applies the fields a write
      // names and says nothing about the others.
      //
      // What actually carries that today is the refresh below, which
      // empties the collection and rewrites it, so no partial update is
      // ever produced and this setting changes nothing that can be
      // observed. It is set anyway, and that is a deliberate belt: a later
      // refresh that diffed instead of replacing would otherwise pick up
      // partial semantics silently, and misplacing this is not a type
      // error — beside `getKey` it is an unknown property the collection
      // ignores, leaving the default quietly in force.
      rowUpdateMode: "full",
      sync: ({ begin, write, commit, markReady, truncate }) => {
        let stopped = false;

        const load = async (): Promise<void> => {
          const rows = await store.visible.listItems({ type });
          if (stopped) return;
          if (rows.length > maxItems) {
            throw new RangeError(
              `@withmarfa/sdk/local: ${type} holds ${String(rows.length)} rows, past the ${String(maxItems)} this projection allows. ` +
                `Raise maxItems if a view of that size is genuinely wanted, or narrow what is projected.`,
            );
          }

          begin();
          // Emptied and rewritten rather than diffed. The store is the
          // only record of what is visible, and working out which rows
          // left would mean keeping a second copy here to compare
          // against — which is the thing this projection exists not to
          // be. `truncate` inside the transaction means a subscriber
          // sees one change rather than a clear followed by a fill.
          truncate();
          for (const row of rows) write({ type: "insert", value: row });
          commit();
        };

        refreshFromSync = async () => {
          try {
            await load();
          } catch (error) {
            onError?.(error);
          }
        };

        void (async () => {
          try {
            await load();
          } catch (error) {
            onError?.(error);
          } finally {
            // Ready even when the first read failed. A collection that
            // never reports ready leaves every consumer waiting for ever
            // on something that has already gone wrong, which is worse
            // than an empty one that can be refreshed.
            markReady();
          }
        })();

        return () => {
          stopped = true;
          refreshFromSync = null;
        };
      },
    },

    utils: {
      refresh: async () => {
        // Nothing to refresh before the collection has started syncing, or
        // after it has stopped. Silent rather than throwing: a refresh is
        // something an app fires on an event, and an event arriving either
        // side of the lifecycle is ordinary.
        await refreshFromSync?.();
      },
    },
  });

  return collection;
}
