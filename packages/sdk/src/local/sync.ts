import { setMaxListeners } from "node:events";
import type { MarfaClient } from "../client.js";
import type { Subscription } from "../events.js";
import { applyEvent } from "./apply.js";
import type { OutboxDrain } from "./drain.js";
import { importAll } from "./import.js";
import type { LocalStore } from "./store/index.js";
import { ReadOnlyStoreError } from "./store/index.js";
import type { LocalEngineEventListener, LocalEngineEvent } from "./types.js";

/**
 * How long `start` waits for the stream to say where the log stands.
 *
 * Matches the transport's own request budget: a connection that has not
 * opened in that time is not slow, it is not happening. Bounded at all
 * because the alternative is a promise that never settles — an engine
 * pointed at a server that is down would sit in `connecting` for the life
 * of the process, with nothing for the caller to catch and nothing to
 * render.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

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
  /** How long `start` waits for the stream's opening announcement before
   *  giving up. Defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
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
  /**
   * How many listener failures are worth printing before it is clear the
   * listener is simply broken.
   *
   * Hydration progress is reported per row, so a listener that always
   * throws would otherwise print a line for every row of a full read —
   * which buries the first one, the only one that says anything.
   */
  const REPORTED_THROWS = 5;
  let throwsSeen = 0;

  /** The last resort, when there is nobody left to tell. */
  const report = (what: string, error: unknown): void => {
    console.error(`@withmarfa/sdk/local: ${what}`, error);
  };

  /**
   * Tell the app, without letting the telling become the failure.
   *
   * The guard belongs here rather than in whatever composes this, because
   * this is where the throw is actually caught: the detached failure path
   * calls this from inside its own catch, so an unguarded call hands the
   * throw straight back to a promise nobody holds and Node ends the
   * process — the exact failure that path exists to prevent. `sync.ts` is
   * a public export, so a consumer reaches it with no engine in the way.
   */
  const emit = (event: LocalEngineEvent): void => {
    const listener = options.onEvent;
    if (listener === undefined) {
      // Nowhere to report to is not the same as nothing to report: a
      // genuine programming error in detached work would otherwise go
      // nowhere at all.
      if (event.type === "sync.error") {
        report(`${event.scope} failed`, event.error ?? event.message);
      }
      return;
    }
    try {
      listener(event);
    } catch (error) {
      throwsSeen += 1;
      if (throwsSeen <= REPORTED_THROWS) report("a listener threw", error);
      else if (throwsSeen === REPORTED_THROWS + 1) {
        report("a listener keeps throwing; further ones are not reported", "");
      }
    }
  };

  /**
   * Retires the engine. Aborted by `stop` and by the caller's own signal,
   * never by a connection giving up — an engine that could not reach the
   * server has not been stopped, and the message it rejects with tells the
   * caller to try again, which it has to be able to do.
   */
  const retired = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) retired.abort();
    else
      options.signal.addEventListener("abort", () => {
        retired.abort();
      });
  }

  /** Cancels the subscription of one `start`. Replaced on each attempt. */
  let attempt = new AbortController();
  // One listener for the life of the engine, reading whichever attempt is
  // current. Registered per start instead — even with `once` — it
  // accumulates one per start on a signal that may never fire, so an app
  // retrying `start` on a timer collects them until Node warns.
  // A ceiling low enough that accumulation is loud. An abort signal warns
  // about nothing by default, so a future change that went back to
  // registering a listener per start would leak one on every attempt in
  // silence — an app retrying a start on a timer collects them for as long
  // as the server is down, and nothing anywhere would say so. Two is above
  // what correct code here uses and far below any plausible legitimate
  // growth.
  setMaxListeners(2, retired.signal);
  retired.signal.addEventListener("abort", () => {
    attempt.abort();
  });
  const linkAttempt = (): AbortSignal => {
    attempt = new AbortController();
    if (retired.signal.aborted) attempt.abort();
    return attempt.signal;
  };

  let subscription: Subscription | undefined;
  /** Settles the wait in `start`: resolved by the announcement, rejected
   *  by a stop or by the connect budget running out. */
  let announceOnce: (() => void) | undefined;

  /**
   * Run work the subscription starts and cannot wait for.
   *
   * The subscription's callbacks are synchronous, so a cursor write or a
   * catch-up read can only be started from one, never awaited by it. That
   * leaves a promise nobody holds, and there are two quite different ways
   * one of them ends badly.
   *
   * A failure after the engine has been stopped is a shutdown: the store
   * closed underneath work already in flight, and reporting it would name
   * a closed client rather than anything a reader can act on. Dropped.
   *
   * A failure while the engine is still running is real, and it is
   * reported rather than thrown. Rethrowing here — into a microtask,
   * because there is nowhere else for it to go — reaches Node as an
   * uncaught exception and ends the host process, so an ordinary bad read
   * on a background reconnect would take an application down with it.
   * That is a worse answer than telling the app the read failed.
   */
  const detached = (
    scope: "stream" | "cursor" | "catchup" | "reimport",
    work: () => Promise<void>,
  ): void => {
    // The controller this work was started under, captured rather than
    // read back later: `linkAttempt` replaces the binding on every start,
    // so in-flight work from an abandoned attempt would otherwise check
    // the *new* attempt's signal, find it running, and report an error
    // about an attempt nobody is waiting on — which is the noise the
    // check exists to suppress.
    const under = attempt;
    void work().catch((error: unknown) => {
      if (under.signal.aborted) return;
      emit({
        type: "sync.error",
        scope,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    });
  };

  /**
   * How many items the server holds, or undefined when it would not say.
   *
   * The stats route counts per lifecycle state, and hydration reads every
   * state, so the sum across them is the number this read is walking
   * towards.
   */
  const countItems = async (): Promise<number | undefined> => {
    try {
      const byState = await client.items.stats();
      return Object.values(byState).reduce((sum, count) => sum + count, 0);
    } catch {
      return undefined;
    }
  };

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
  const reimport = async (): Promise<boolean> => {
    if (drain !== undefined) await drain.drain();

    // A drain does not promise an empty queue. It returns with rows still
    // pending whenever it could not reach the server, or whenever
    // something ahead of them was held back — so checking is the
    // difference between reporting that the re-import could not run and
    // throwing out of work nobody is holding.
    const stillPending = (await store.outbox.list()).filter(
      (entry) => entry.state === "pending",
    ).length;
    if (stillPending > 0) {
      emit({
        type: "sync.error",
        scope: "reimport",
        message:
          `Cannot re-import while ${String(stillPending)} write(s) are still waiting to be sent. ` +
          `The cursor has aged out of the event log, so this store needs a full read before it can follow ` +
          `the stream again: drain the queue and start the engine again.`,
        error: undefined,
      });
      // The cursor is left where it was. Clearing it here would lose the
      // one record that a re-import is still owed.
      return false;
    }

    // Recorded before anything is destroyed, because the cursor cannot
    // carry this on its own: it is cleared next, and a read that fails
    // part-way then leaves null — which is also what a store that has
    // never connected looks like. Only one of the two owes a full read,
    // and the other must not be given one.
    await store.syncState.setReimportOwed(store.identity, now());
    // The cursor is worthless and saying so is what stops a later start
    // resuming from it. Cleared before the read rather than after, because
    // a crash mid-read must not leave a cursor that claims a completed
    // subscription.
    await store.syncState.setCursor(store.identity, null);
    const result = await importAll({ store, client, prune: true });
    // Cleared only once the read has actually finished. Anything that
    // throws above leaves it set, and the next start does this again.
    await store.syncState.setReimportOwed(store.identity, null);
    emit({
      type: "reimport.finished",
      items: result.items,
      edges: result.edges,
      prunedItems: result.prunedItems,
      prunedEdges: result.prunedEdges,
    });
    return true;
  };

  const subscribe = (resume: string | undefined): Subscription => {
    let opens = 0;
    return client.events.subscribe({
      ...(resume === undefined ? {} : { lastEventId: resume }),
      ...(options.initialRetryMs === undefined
        ? {}
        : { initialRetryMs: options.initialRetryMs }),
      signal: attempt.signal,
      onOpen: () => {
        opens += 1;
        emit({ type: "connection.changed", state: "online" });
        // Not on the first: that connection's gap is what `start`'s own
        // read covers, and running both would read the corpus twice.
        if (opens > 1) detached("catchup", catchUp);
      },
      onError: (error: unknown) => {
        // Reconnecting is right; saying nothing about it is not. Without
        // this a store that refuses an event stops the stream there — as
        // it should — and then reconnects into the same refusal for ever,
        // looking from outside exactly like a quiet server.
        emit({ type: "connection.changed", state: "offline" });
        emit({
          type: "sync.error",
          scope: "stream",
          message: error instanceof Error ? error.message : String(error),
          error,
        });
      },
      onCursor: (cursor) => {
        // Recorded only when the store has none. A resuming store keeps
        // the cursor it came with: the announcement names the head of the
        // log, which sits past the backlog about to be replayed, so taking
        // it here would step over events not yet delivered.
        detached("cursor", async () => {
          const row = await store.syncState.read(store.identity);
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
        // After the apply and inside the awaited handler, so anything
        // listening reads a store that already holds the change rather
        // than racing it.
        emit({ type: "store.changed", eventId });
      },
      onCatchupTooOld: () => {
        detached("reimport", async () => {
          // Only on a re-import that actually happened. Resubscribing
          // after one that did not would adopt the new connection's
          // announcement as this store's cursor and carry on live, with
          // the rows the re-import would have pruned still held and
          // nothing left that could ever notice them.
          if (!(await reimport())) {
            // The subscription is gone with the refusal, so the state it
            // last reported is a connection that no longer exists.
            emit({ type: "connection.changed", state: "offline" });
            return;
          }
          if (!attempt.signal.aborted) subscription = subscribe(undefined);
        });
      },
    });
  };

  return {
    start: async () => {
      // Following the stream means recording where it has reached, and a
      // handle another engine is holding cannot write. Refused here, with
      // the reason, rather than left to surface as a failed cursor write
      // from somewhere far from the cause.
      if (!store.writer) {
        throw new ReadOnlyStoreError(
          "another engine, so this handle cannot record a cursor",
        );
      }

      // A fresh cancellation scope for this attempt, so a previous one
      // that gave up waiting does not carry its abort into this one.
      linkAttempt();

      const budget = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      // Left undeclared rather than initialized: every path that skips
      // the assignment below throws out of `start`, so a default would be
      // a value nothing can read.
      let hydratedAt: string | null | undefined;
      let owesReimport: boolean | undefined;
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      let stopWaiting: (() => void) | undefined;
      const announced = new Promise<void>((resolve, reject) => {
        announceOnce = resolve;

        // The abort signal rather than a callback the stop reaches for,
        // because a stop can land before this promise exists: `start` is
        // async and does a read first, so a caller that starts and stops
        // without awaiting would leave a callback unset and the wait
        // never settled. The controller is already the one record of
        // whether this subscription is running, and it is set from the
        // moment the engine is built.
        const abandon = (): void => {
          reject(
            new Error(
              "@withmarfa/sdk/local: the engine was stopped before the stream announced its position.",
            ),
          );
        };
        if (retired.signal.aborted) abandon();
        else {
          retired.signal.addEventListener("abort", abandon);
          stopWaiting = () => {
            retired.signal.removeEventListener("abort", abandon);
          };
        }

        giveUp = setTimeout(() => {
          // Rejected before the abort, so this reports the budget rather
          // than the stop that enforces it — a promise settles once, and
          // aborting first would relabel every timeout as a stop.
          reject(
            new Error(
              `@withmarfa/sdk/local: the engine did not connect within ${String(budget)}ms. ` +
                `The store is still readable and its queue is intact; start again when the server is reachable.`,
            ),
          );
          emit({ type: "connection.changed", state: "offline" });
          // This attempt's subscription goes with the rejection — leaving
          // one running behind a start that failed is a background
          // reconnect loop nobody asked for and nobody can see — and only
          // that attempt's, so the engine stays startable.
          attempt.abort();
        }, budget);
      });

      // The read comes after the wait is armed, not before. Everything
      // above is synchronous with the call, so a caller that starts and
      // stops without awaiting cannot land its stop in a gap where
      // nothing is listening — and the budget covers the whole of `start`
      // rather than only the part after a database read.
      // Everything from the read onwards is inside the cleanup, including
      // the early exit. Left outside it, a stop landing during the read
      // returns through a path that clears nothing: the give-up timer
      // stays armed, fires later, reports offline over the stopped state
      // the app was last shown, and — holding a reference — keeps the
      // event loop alive, so a command-line tool that stops the engine and
      // expects to exit does not.
      try {
        const state = await store.syncState.read(store.identity);
        const resume = state?.cursor ?? undefined;
        if (retired.signal.aborted) await announced;

        emit({ type: "connection.changed", state: "connecting" });
        subscription = subscribe(resume);
        // The stream is open and has told us where it stands before a
        // single row is read. Everything the read then misses is something
        // the subscription is already holding.
        await announced;
        hydratedAt = state?.hydratedAt ?? null;
        owesReimport = state?.reimportOwedAt != null;
      } finally {
        clearTimeout(giveUp);
        stopWaiting?.();
        announceOnce = undefined;
      }

      // A read this store still owes, from a re-import that did not
      // finish. It comes before the hydration check because it is the
      // stronger obligation: this store holds rows and some of them may be
      // gone from the server, which only a prune can find.
      if (owesReimport) {
        if (!(await reimport())) {
          // The subscription is live and following from the announced
          // head, and the store is still not a faithful copy: rows the
          // server dropped may be held, and only the prune this could not
          // run would find them. Reporting online here would tell an app
          // it is up to date over exactly that. The flag survives, so the
          // next start tries again.
          emit({ type: "connection.changed", state: "offline" });
        }
        return;
      }

      if (hydratedAt == null) {
        // What the server says it holds, read once before the walk so the
        // progress below has a denominator. Best-effort: a credential that
        // cannot see the stats route, or a server that will not answer,
        // leaves the total unknown rather than stopping the hydration —
        // a read with no progress bar is worth more than no read.
        const totalItems = await countItems();

        // A fresh store reads everything on start. No prune: there is
        // nothing here yet that the server could have dropped, and running
        // one would only ask the same question of an empty set.
        const result = await importAll({
          store,
          client,
          prune: false,
          onProgress: ({ items, edges }) => {
            emit({ type: "hydration.progress", items, edges, totalItems });
          },
        });
        // Stamped after the read rather than before. A process that dies
        // part-way through comes back with this still unset and reads
        // again, which is the only way the counts can be trusted to have
        // reached the total they were measured against.
        await store.syncState.setHydratedAt(store.identity, now());
        emit({
          type: "hydration.finished",
          items: result.items,
          edges: result.edges,
        });
      }
    },

    stop: () => {
      retired.abort();
      attempt.abort();
      subscription?.close();
      // The abort above is what settles a `start` still waiting on an
      // announcement that is now never coming.
      emit({ type: "connection.changed", state: "stopped" });
    },

    get closed() {
      return subscription?.closed ?? Promise.resolve();
    },
  };
}
