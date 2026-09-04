import type { LocalEngineStatus } from "../local/engine.js";
import type {
  DeadLetterEntry,
  LocalEngineEvent,
  VisibleEdge,
  VisibleItem,
  VisibleMetadata,
} from "../local/types.js";

/**
 * The wire between an Electron main process holding the engine and a
 * sandboxed renderer that may not touch it directly.
 *
 * Shared by both halves so the two cannot drift. Types only from the engine
 * — nothing here imports the store, so a preload bundling this file does not
 * pull `@libsql/client` or `drizzle-orm` into a context that could not load
 * a native addon anyway.
 */

/** Where the renderer's calls land. */
export const LOCAL_INVOKE_CHANNEL = "marfa.local.invoke";

/** Where the engine's events are pushed. */
export const LOCAL_EVENT_CHANNEL = "marfa.local.event";

/** The name the bridge takes on `window`. */
export const LOCAL_BRIDGE_KEY = "marfaLocal";

/**
 * The engine, as a sandboxed renderer sees it.
 *
 * This interface is the contract rather than a description of one: the main
 * process's handler table is keyed by {@link LocalMethod}, which is derived
 * from here, so a method added to this interface and not handled fails to
 * compile rather than failing on a user's machine.
 *
 * Everything is a promise, including the two that are synchronous on the
 * engine — `stop` returns nothing and `store.visible` reads are already
 * async, but a process boundary makes all of them round trips and pretending
 * otherwise would put a lie in the type.
 */
export interface MarfaLocalBridge {
  /** Subscribe, read, and start following the stream. */
  start(): Promise<void>;
  /** Stop following. The store keeps everything it holds. */
  stop(): Promise<void>;
  /** Send what can be sent, once. */
  drain(): Promise<void>;
  /** Everything the app renders, read fresh. */
  status(): Promise<LocalEngineStatus>;

  getItem(id: string): Promise<VisibleItem | undefined>;
  listItems(filters?: { type?: string }): Promise<VisibleItem[]>;
  getEdge(id: string): Promise<VisibleEdge | undefined>;
  listEdges(): Promise<VisibleEdge[]>;
  getMetadata(itemId: string): Promise<VisibleMetadata | undefined>;

  createItem(input: {
    type: string;
    properties: Record<string, unknown>;
    id?: string;
    timestamp?: string;
    source_id?: string;
  }): Promise<VisibleItem>;
  updateItem(
    id: string,
    properties: Record<string, unknown>,
  ): Promise<VisibleItem>;
  deleteItem(id: string): Promise<void>;
  createEdge(input: {
    source_id: string;
    target_id: string;
    edge_type: string;
    properties?: Record<string, unknown>;
    id?: string;
  }): Promise<VisibleEdge>;
  updateEdge(
    id: string,
    properties: Record<string, unknown>,
  ): Promise<VisibleEdge>;
  deleteEdge(id: string): Promise<void>;

  /** Writes the server refused, kept for the app to show. */
  listDeadLetters(): Promise<DeadLetterEntry[]>;

  /**
   * Engine events, pushed rather than polled. Returns the function that
   * stops listening.
   *
   * Not one of the {@link LocalMethod}s: it takes a function, and a function
   * cannot cross the boundary as an argument. The renderer's listener stays
   * in the renderer and the preload relays to it.
   */
  on(listener: (event: BridgeEngineEvent) => void): () => void;
}

/**
 * The methods the renderer may name.
 *
 * Derived from the bridge rather than written beside it. A closed set is
 * what stops a renderer reaching a method the host never published, and a
 * hand-kept copy of that set is one rename away from either refusing a real
 * method or admitting one nobody meant to expose.
 */
export type LocalMethod = Exclude<keyof MarfaLocalBridge, "on">;

/**
 * The same set at runtime, for the preload to build its object from.
 *
 * `satisfies` holds it to the type in one direction — nothing here can name
 * a method the bridge does not have. The other direction, that every bridge
 * method appears here, is what `bridge.test.ts` checks; a tuple's members
 * are not something a type can require to be exhaustive.
 */
export const LOCAL_METHODS = [
  "start",
  "stop",
  "drain",
  "status",
  "getItem",
  "listItems",
  "getEdge",
  "listEdges",
  "getMetadata",
  "createItem",
  "updateItem",
  "deleteItem",
  "createEdge",
  "updateEdge",
  "deleteEdge",
  "listDeadLetters",
] as const satisfies readonly LocalMethod[];

/** One call from the renderer. */
export interface InvokeRequest {
  method: string;
  args: unknown[];
}

/**
 * One answer, success or failure, as data.
 *
 * The main process resolves this rather than rejecting, because a rejection
 * out of `ipcMain.handle` reaches the renderer as a string with Electron's
 * own prefix wrapped round it: the class is gone, and with it every way an
 * app had to tell `ReadOnlyStoreError` — this window is not the writer, show
 * a banner — from a store that simply has no such item. Carrying the name
 * as a field is what survives the boundary.
 */
export type InvokeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

/**
 * An engine event as the renderer receives it.
 *
 * `sync.error` loses its `error` field on the way across. Everything on this
 * channel goes through the structured clone algorithm, and that field is
 * whatever was thrown — which is usually an `Error` and is under no
 * obligation to be. A value clone refuses takes the send down with it, on
 * the one path whose whole purpose is reporting a failure without crashing,
 * so the field that cannot be relied on to travel does not travel. `message`
 * carries what a person needs; the value itself stays in the main process,
 * where a listener can still reach it.
 */
export type BridgeEngineEvent =
  | Exclude<LocalEngineEvent, { type: "sync.error" }>
  | {
      type: "sync.error";
      scope: Extract<LocalEngineEvent, { type: "sync.error" }>["scope"];
      message: string;
    };

/** Strip an engine event down to what can cross a process boundary. */
export function forRenderer(event: LocalEngineEvent): BridgeEngineEvent {
  if (event.type !== "sync.error") return event;
  return { type: "sync.error", scope: event.scope, message: event.message };
}
