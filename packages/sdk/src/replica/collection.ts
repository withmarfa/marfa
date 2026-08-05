/**
 * A local replica of a Marfa type, as a TanStack DB collection.
 *
 * Reads in the interactive path come from here rather than from the
 * network. Writes apply locally first and are persisted through the
 * ordinary API, so permissions, validation and conflict resolution stay
 * where they already live — on the server. That is the whole reason this
 * is built on the API and the change stream rather than on a direct
 * database connection: a replica that reaches past the API reaches past
 * every rule the API enforces.
 *
 * Two orderings are load-bearing and easy to get backwards.
 *
 * The subscription opens **before** the initial read, and events that
 * arrive during it are buffered rather than applied. Opening it after
 * would lose every change that landed between the read finishing and the
 * stream starting, and the gap is invisible: the replica looks populated
 * and is quietly stale.
 *
 * A `catchup_too_old` from the server means the cursor predates the
 * retention window, so the gap cannot be filled by replaying. Reconnecting
 * with the same cursor loops; reconnecting without one looks healthy and
 * silently skips everything in the gap. The only honest response is to
 * throw the local copy away and read it again, which is what this does.
 */
import { createCollection } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import type { Item } from "@withmarfa/shared";
import type { MarfaClient } from "../client.js";
import type { ConflictStrategy } from "../conflict.js";

export interface ReplicaOptions {
  /** Marfa type to replicate, e.g. `core.note`. */
  type: string;
  /**
   * How a write that the server says conflicts is resolved. Defaults to
   * `auto`, the same default the direct client uses, so a replica and a
   * direct write answer a conflict identically. Diverging here is how
   * two clients of one platform end up with two behaviours a user can
   * see.
   */
  conflict?: ConflictStrategy;
  /** Page size for the initial read. */
  pageSize?: number;
  /**
   * Called when the replica had to discard and reload — the cursor aged
   * out of the server's retention window. Surfaced rather than swallowed
   * because a caller may want to tell the user why the view blinked.
   */
  onResync?: (reason: "catchup_too_old") => void;
  /** Called on a stream error the replica could not recover from. */
  onError?: (error: unknown) => void;
  /**
   * Override the change stream. Defaults to the client's own.
   *
   * A seam rather than a test hook: it is what lets the buffering
   * ordering be proven deterministically, because the alternative is a
   * test that races the network and reports scheduling as a defect. It
   * also lets a consumer feed the replica from a stream it already has
   * open rather than opening a second one.
   */
  subscribe?: MarfaClient["events"]["subscribe"];
}

/** What the replica exposes beyond the collection itself. */
export interface ReplicaUtils {
  /** Discard the local copy and read it again from the server. */
  resync: () => Promise<void>;
  /** Stop syncing. The collection keeps whatever it last held. */
  stop: () => void;
}

type ReplicaCollection = Collection<Item, string, ReplicaUtils>;

/**
 * Build a replica collection for one Marfa type.
 *
 * The collection is live from the moment it is created: it performs its
 * initial read and then follows the change stream. Nothing here is
 * awaited by the caller, because a UI that must wait for a network round
 * trip before rendering is the thing a replica exists to remove.
 */
export function createReplicaCollection(
  client: MarfaClient,
  options: ReplicaOptions,
): ReplicaCollection {
  const { type, pageSize = 200 } = options;
  let stopStream: (() => void) | null = null;
  let restart: (() => void) | null = null;

  const collection = createCollection<Item, string, ReplicaUtils>({
    id: `marfa:${type}`,
    getKey: (item) => item.id,

    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        // One cancellation primitive rather than a flag plus a closure:
        // the stream already accepts a signal, and `aborted` is a real
        // runtime read rather than something the compiler narrows away.
        const cancel = new AbortController();
        let initialReadDone = false;
        const buffered: { kind: "upsert" | "delete"; item: Item }[] = [];

        const apply = (kind: "upsert" | "delete", item: Item): void => {
          begin();
          if (kind === "delete") {
            write({ type: "delete", value: item });
          } else {
            // The stream does not distinguish a first sight of an item
            // from a later one, and neither does a replica: whether this
            // row is new here depends on what we already hold, not on
            // what the server called the event.
            write({
              type: collection.has(item.id) ? "update" : "insert",
              value: item,
            });
          }
          commit();
        };

        const drain = (): void => {
          for (const event of buffered) apply(event.kind, event.item);
          buffered.length = 0;
        };

        const subscribe = options.subscribe ?? client.events.subscribe;
        const subscription = subscribe({
          type,
          signal: cancel.signal,
          onEvent: (event) => {
            if (cancel.signal.aborted) return;
            // Edge events carry no item, and a replica of a type has
            // nothing to do with them.
            if (!("item" in event)) return;
            const kind =
              event.type === "item.deleted"
                ? ("delete" as const)
                : ("upsert" as const);
            if (!initialReadDone) {
              buffered.push({ kind, item: event.item });
              return;
            }
            apply(kind, event.item);
          },
          onCatchupTooOld: () => {
            options.onResync?.("catchup_too_old");
            restart?.();
          },
          onError: (err) => {
            options.onError?.(err);
          },
        });
        stopStream = () => {
          subscription.close();
        };

        void (async () => {
          try {
            let cursor: string | undefined;
            const seen: Item[] = [];
            for (;;) {
              const page = await client.items.list({
                type,
                limit: pageSize,
                ...(cursor ? { cursor } : {}),
              });
              seen.push(...page.data);
              if (!page.has_more || !page.cursor) break;
              cursor = page.cursor;
            }

            if (cancel.signal.aborted) return;
            begin();
            for (const item of seen) write({ type: "insert", value: item });
            commit();
            initialReadDone = true;
            drain();
          } catch (err) {
            options.onError?.(err);
          } finally {
            // Ready even on failure: a collection that never reports
            // ready leaves every consumer waiting forever on a network
            // problem, which is worse than an empty one that can retry.
            markReady();
          }
        })();

        return () => {
          cancel.abort();
          stopStream?.();
          stopStream = null;
        };
      },
    },

    // Writes go through the ordinary client, so the server stays the one
    // place that decides whether a write is allowed and how a conflict
    // resolves.
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const item = mutation.modified;
        await client.items.create({ type, properties: item.properties });
      }
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const item = mutation.modified;
        await client.items.update(
          item.id,
          { properties: item.properties },
          { conflict: options.conflict ?? "auto" },
        );
      }
    },
    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        await client.items.delete(String(mutation.key));
      }
    },

    utils: {
      resync: async () => {
        await Promise.resolve();
        restart?.();
      },
      stop: () => {
        stopStream?.();
        stopStream = null;
      },
    },
  });

  restart = () => {
    // Re-running sync is what discards the stale copy: the collection
    // re-reads from scratch and the old rows are replaced wholesale.
    collection.cleanup().then(
      () => {
        void collection.preload();
      },
      () => {
        /* a cleanup failure is not worth compounding with a throw */
      },
    );
  };

  return collection;
}
