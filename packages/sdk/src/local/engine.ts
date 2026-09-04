import type { MarfaClient } from "../client.js";
import { createOutboxDrain, type OutboxDrain } from "./drain.js";
import { createLocalSync, type LocalSync } from "./sync.js";
import type { LocalStore } from "./store/index.js";
import { ReadOnlyStoreError } from "./store/index.js";
import type {
  ConnectionState,
  LocalEngineEvent,
  LocalEngineEventListener,
  StoreIdentity,
} from "./types.js";

/**
 * What the engine will tell an app about itself.
 *
 * A snapshot rather than a live object: every field is read at the moment
 * it is asked for, so nothing here can describe a state the store has
 * already left.
 */
export interface LocalEngineStatus {
  connection: ConnectionState;
  /** Which server, space and account this store belongs to. */
  identity: StoreIdentity;
  /** False when another engine holds the store and this handle can only
   *  read. An app showing a sync status has to say so: nothing this
   *  process writes will ever be sent. */
  writer: boolean;
  /** Mutations waiting to be sent. */
  pending: number;
  /** Mutations parked, by reason. Split rather than totalled because what
   *  clears them differs: a suspended space passes on its own, a write
   *  awaiting review does not. */
  blocked: Record<string, number>;
  /** Writes the server refused, kept for the app to show. */
  deadLetters: number;
  /** When the queue last emptied cleanly, or null if it never has. */
  lastDrainedAt: string | null;
  /** Where the stream has reached, or null before it has said. */
  cursor: string | null;
  /**
   * The last thing the engine could not finish, or null if nothing has
   * failed since it was built.
   *
   * Here as well as on the event stream because an app that polls rather
   * than subscribes, or one that attached a listener after the fact, has
   * no other way to learn that a catch-up has been failing all afternoon.
   * It is not cleared by a later success: it says what went wrong last,
   * and an app that wants "is it wrong now" reads `connection`.
   */
  lastError: { scope: string; message: string; at: string } | null;
  hydration: {
    /** Whether the first full read has completed. */
    done: boolean;
    /** Rows taken so far on the read in progress. Monotonic. */
    items: number;
    edges: number;
    /** What the server said it held, or undefined when it would not say. */
    totalItems: number | undefined;
  };
}

export interface LocalEngineOptions {
  store: LocalStore;
  client: MarfaClient;
  /** Transient attempts a mutation gets before it parks. */
  retryCeiling?: number;
  /** First reconnect backoff in ms. */
  initialRetryMs?: number;
  /** How long `start` waits for the stream's opening announcement. */
  connectTimeoutMs?: number;
  now?: () => string;
}

export interface LocalEngine {
  /** Subscribe, read, and start following the stream. */
  start(): Promise<void>;
  /** Stop following. The store keeps everything it holds. */
  stop(): void;
  /** Send what can be sent, once. */
  drain(): Promise<void>;
  /** Everything an app renders, read fresh. */
  status(): Promise<LocalEngineStatus>;
  /**
   * Events that cannot wait for the next `status` call, because each one
   * is work that has stopped moving or a change a person will notice.
   * Returns the function that stops listening.
   */
  on(listener: LocalEngineEventListener): () => void;
  readonly store: LocalStore;
}

/**
 * The engine, as one object an app can hold.
 *
 * It exists so that reporting has somewhere to live. The store, the queue
 * and the stream each know part of what a person needs to see — how much
 * is waiting, why something stopped, whether anything is getting through —
 * and an app assembling that itself would have to reach into all three and
 * would still have nowhere to put connection state, which none of them
 * keeps.
 */
export function createLocalEngine(options: LocalEngineOptions): LocalEngine {
  const { store, client } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<LocalEngineEventListener>();

  let connection: ConnectionState = "idle";
  let lastError: LocalEngineStatus["lastError"] = null;
  let hydrationItems = 0;
  let hydrationEdges = 0;
  let totalItems: number | undefined;

  const emit = (event: LocalEngineEvent): void => {
    // Connection state is derived from what the engine reports rather than
    // tracked beside it, so the two cannot disagree — there is only one
    // record of what happened and this reads it. The stream is what
    // reports it, because the stream is the only part continuously in
    // contact: derived from the drain instead, a queue with nothing in it
    // never fails to send, so the field reads healthy through an entire
    // backoff loop.
    if (event.type === "hydration.progress") {
      hydrationItems = event.items;
      hydrationEdges = event.edges;
      totalItems = event.totalItems;
    }
    if (event.type === "connection.changed") connection = event.state;
    if (event.type === "sync.error") {
      lastError = {
        scope: event.scope,
        message: event.message,
        at: now(),
      };
    }

    // A listener that throws must not take the emit down with it. This is
    // reached from the handler that catches a detached failure, whose
    // whole purpose is not to crash, so a throw here would put the
    // rejection straight back where it was just taken from — and the
    // caller would see an unhandled rejection naming their own listener.
    // The failure is still visible: each listener is given the event
    // whatever the one before it did, and the throw is reported below.
    const refused: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        refused.push(error);
      }
    }
    for (const error of refused) report("a listener threw", error);

    // Nowhere to report to is not the same as nothing to report. An
    // engine with no listener at all would otherwise drop a genuine
    // programming error in detached work silently, which is the failure
    // this whole path exists to avoid.
    if (listeners.size === 0 && event.type === "sync.error") {
      report(`${event.scope} failed`, event.error ?? event.message);
    }
  };

  /** The last resort, when there is nobody to tell. */
  const report = (what: string, error: unknown): void => {
    console.error(`@withmarfa/sdk/local: ${what}`, error);
  };

  /** Refuse the two things a handle another engine holds cannot do. */
  const requireWriter = (): void => {
    if (store.writer) return;
    throw new ReadOnlyStoreError(
      "another engine, so this handle can read but not sync or send",
    );
  };

  const drain: OutboxDrain = createOutboxDrain({
    store,
    client,
    ...(options.retryCeiling === undefined
      ? {}
      : { retryCeiling: options.retryCeiling }),
    onEvent: emit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const sync: LocalSync = createLocalSync({
    store,
    client,
    drain,
    onEvent: emit,
    ...(options.initialRetryMs === undefined
      ? {}
      : { initialRetryMs: options.initialRetryMs }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    store,

    start: async () => {
      requireWriter();
      await sync.start();
    },

    stop: () => {
      sync.stop();
    },

    drain: async () => {
      requireWriter();
      const result = await drain.drain();
      // The drain corroborates the stream in one direction only, and the
      // asymmetry is a choice rather than a property of the evidence: a
      // completed round trip is direct and newer than anything a stream
      // mid-backoff is saying. It is still not allowed to clear `offline`,
      // because the two answer different questions — a drain that worked
      // proves the server is reachable, and this field says whether the
      // engine is following it. Letting reachability overwrite that would
      // mask exactly the state it exists to surface: a healthy network
      // with a subscription that has been retrying for an hour.
      if (result.offline) connection = "offline";
    },

    status: async () => {
      const queued = await store.outbox.list();
      const blocked: Record<string, number> = {};
      let pending = 0;
      for (const entry of queued) {
        if (entry.state === "pending") {
          pending += 1;
          continue;
        }
        const reason = entry.blockedReason ?? "unknown";
        blocked[reason] = (blocked[reason] ?? 0) + 1;
      }
      const state = await store.syncState.read(store.identity);
      return {
        connection,
        identity: store.identity,
        writer: store.writer,
        pending,
        blocked,
        deadLetters: (await store.deadLetters.list()).length,
        lastDrainedAt: state?.lastDrainedAt ?? null,
        cursor: state?.cursor ?? null,
        lastError,
        hydration: {
          done: state?.hydratedAt != null,
          items: hydrationItems,
          edges: hydrationEdges,
          totalItems,
        },
      };
    },

    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
