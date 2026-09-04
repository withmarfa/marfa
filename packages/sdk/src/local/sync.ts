import type { MarfaClient } from "../client.js";
import type { Subscription } from "../events.js";
import { applyEvent } from "./apply.js";
import type { OutboxDrain } from "./drain.js";
import { importAll } from "./import.js";
import type { LocalStore } from "./store/index.js";
import type { LocalEngineEventListener, LocalEngineEvent } from "./types.js";

export interface LocalSyncOptions {
  store: LocalStore;
  client: MarfaClient;
  /**
   * The queue, drained before a re-import.
   *
   * Optional so a read-only consumer needs no outbox machinery, and the
   * import refuses over pending writes either way — so omitting it turns a
   * silent race into a refusal rather than into a risk.
   */
  drain?: OutboxDrain;
  /** Where the engine tells the app what has happened. */
  onEvent?: LocalEngineEventListener;
  /** Stops the subscription. */
  signal?: AbortSignal;
  /** First reconnect backoff in ms. Lowered by tests; the default is the
   *  subscription's own. */
  initialRetryMs?: number;
  now?: () => string;
}

export interface LocalSync {
  /**
   * Subscribe, then read.
   *
   * Resolves once the store holds a full picture: the subscription is open
   * and the first read has finished. Later events arrive on their own.
   */
  start(): Promise<void>;
  /** Stops the subscription. Idempotent. */
  stop(): void;
  /** Resolves when the subscription has stopped for good. */
  readonly closed: Promise<void>;
}

/**
 * The stream half of the engine: what the server says, into the store.
 *
 * **Subscribe first, then read.** The other order has a hole in it that no
 * amount of care closes: anything changing between the read finishing and
 * the subscription opening is missed by both, and nothing afterwards ever
 * reports it. Subscribing first makes the overlap the failure mode instead,
 * and an overlap is free — every write is version-compared, so an event
 * delivered twice, or delivered and then re-read, settles to the same row.
 *
 * The server announces the log position it opened at as the first frame,
 * which is what makes this work on a quiet space: without it a client that
 * subscribed, read, and was interrupted would have no cursor to resume
 * from and no way to know it had missed anything.
 */
export function createLocalSync(options: LocalSyncOptions): LocalSync {
  const { store, client, drain } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const emit = (event: LocalEngineEvent): void => {
    options.onEvent?.(event);
  };

  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else
      options.signal.addEventListener("abort", () => {
        controller.abort();
      });
  }

  let subscription: Subscription | undefined;
  /** Resolves on the connection that carried the announced cursor. */
  let announceOnce: (() => void) | undefined;

  /**
   * Read whatever changed since the newest row held.
   *
   * Run on every reconnect, before the connection's own frames are
   * trusted to be the whole story. The event log is bounded and a
   * disconnection is not, so a client that was away long enough has a gap
   * the replay cannot cover and the stream will never mention.
   *
   * The mark is the newest `updated_at` in the store rather than a stored
   * high-water column, so it cannot describe rows the store does not
   * actually hold.
   */
  const catchUp = async (): Promise<void> => {
    const newestItem = await store.server.items.maxUpdatedAt();
    const newestEdge = await store.server.edges.maxUpdatedAt();
    const marks = [newestItem, newestEdge].filter(
      (mark): mark is string => mark !== undefined,
    );
    // Nothing held means nothing to catch up on — the first read covers it.
    if (marks.length === 0) return;
    // The older of the two, so neither half is asked for less than it
    // needs. Taking the newer would skip everything the other half changed
    // in between.
    const since = marks.reduce((a, b) => (a < b ? a : b));
    const result = await importAll({
      store,
      client,
      prune: false,
      updatedAfter: since,
    });
    emit({
      type: "catchup.finished",
      since,
      items: result.items,
      edges: result.edges,
    });
  };

  /**
   * The cursor has aged out of the log, so reconnecting is not an option:
   * asking again with it loops on the same refusal, and dropping it
   * silently skips every change in the gap.
   *
   * Drain first, so the client's own unsent writes are not read over and
   * then contradicted. Then read everything and remove what the server no
   * longer has — the only way a removal from outside the retention window
   * ever reaches a client that was away for it.
   */
  const reimport = async (): Promise<void> => {
    if (drain !== undefined) await drain.drain();
    // The cursor is worthless and saying so is what stops a later start
    // resuming from it. Cleared before the read rather than after, because
    // a crash mid-read must not leave a cursor that claims a completed
    // subscription.
    await store.syncState.setCursor(store.identity, null);
    const result = await importAll({ store, client, prune: true });
    emit({
      type: "reimport.finished",
      items: result.items,
      edges: result.edges,
      prunedItems: result.prunedItems,
      prunedEdges: result.prunedEdges,
    });
  };

  const subscribe = (resume: string | undefined): Subscription => {
    let opens = 0;
    return client.events.subscribe({
      ...(resume === undefined ? {} : { lastEventId: resume }),
      ...(options.initialRetryMs === undefined
        ? {}
        : { initialRetryMs: options.initialRetryMs }),
      signal: controller.signal,
      onOpen: () => {
        opens += 1;
        // Not on the first: that connection's gap is what `start`'s own
        // read covers, and running both would read the corpus twice.
        if (opens > 1) void catchUp();
      },
      onCursor: (cursor) => {
        // Recorded only when the store has none. A resuming store keeps
        // the cursor it came with: the announcement names the head of the
        // log, which sits past the backlog about to be replayed, so taking
        // it here would step over events not yet delivered.
        void store.syncState.read(store.identity).then(async (row) => {
          if (row?.cursor == null) {
            await store.syncState.setCursor(store.identity, cursor);
          }
          announceOnce?.();
        });
      },
      onEvent: async (event, eventId) => {
        // Awaited by the subscription before its own cursor advances, so a
        // store that refuses an event stops the stream at that event
        // rather than skipping past it.
        await applyEvent(store, event, eventId);
      },
      onCatchupTooOld: () => {
        void reimport().then(() => {
          // Resubscribe from nothing: the new connection announces a
          // cursor, and that is what the re-imported state resumes from.
          if (!controller.signal.aborted) subscription = subscribe(undefined);
        });
      },
    });
  };

  return {
    start: async () => {
      const state = await store.syncState.read(store.identity);
      const resume = state?.cursor ?? undefined;

      const announced = new Promise<void>((resolve) => {
        announceOnce = resolve;
      });
      subscription = subscribe(resume);
      // The stream is open and has told us where it stands before a single
      // row is read. Everything the read then misses is something the
      // subscription is already holding.
      await announced;

      if (state?.hydratedAt == null) {
        // A fresh store reads everything on start. No prune: there is
        // nothing here yet that the server could have dropped, and running
        // one would only ask the same question of an empty set.
        const result = await importAll({ store, client, prune: false });
        await store.syncState.setHydratedAt(store.identity, now());
        emit({
          type: "hydration.finished",
          items: result.items,
          edges: result.edges,
        });
      }
    },

    stop: () => {
      controller.abort();
      subscription?.close();
    },

    get closed() {
      return subscription?.closed ?? Promise.resolve();
    },
  };
}
