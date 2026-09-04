import { mkdirSync } from "node:fs";
import type {
  IpcMain,
  IpcMainInvokeEvent,
  WebContents,
  WebPreferences,
} from "electron";
import type { MarfaClient } from "../client.js";
import { createLocalEngine, type LocalEngine } from "../local/engine.js";
import { openLocalStore, type LocalStore } from "../local/store/index.js";
import type { StoreRecovery } from "../local/store/index.js";
import type { StoreIdentity } from "../local/types.js";
import {
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  forRenderer,
} from "./protocol.js";
import type { InvokeRequest, InvokeResult, LocalMethod } from "./protocol.js";
import { localStoreDirectory, localStorePath } from "./store-path.js";

/**
 * The engine, hosted in an Electron main process.
 *
 * It exists as code rather than as a page of instructions because the two
 * halves of an Electron integration are only correct together, and a written
 * recipe is a copy: the channel names, the argument shapes and the
 * `webPreferences` all have to agree across a process boundary, and every
 * copy of them drifts on its own schedule. Here a disagreement is a type
 * error in the application that made it.
 */

export interface ElectronLocalHostOptions {
  /** `app.getPath("userData")`. */
  userData: string;
  /** Which server, space and account this store belongs to. */
  identity: StoreIdentity;
  client: MarfaClient;
  /** Transient attempts a mutation gets before it parks. */
  retryCeiling?: number;
  /** First reconnect backoff in ms. */
  initialRetryMs?: number;
  /** How long `start` waits for the stream's opening announcement. */
  connectTimeoutMs?: number;
  /** Told when a store had to be set aside and rebuilt. */
  onRecovery?: (recovery: StoreRecovery) => void;
}

export interface ServeOptions {
  /**
   * Electron's `ipcMain`, as itself.
   *
   * Typed against Electron's own declaration rather than a narrowed
   * stand-in. A stand-in has to be kept in step with the thing it stands
   * for, and the version that is not is the one that compiles while the
   * application does not — which is the whole failure this subpath exists to
   * take off applications. `electron` is a devDependency here for exactly
   * this: the types are what make the contract checkable.
   */
  ipcMain: IpcMain;
  /**
   * The renderers engine events go to, read at the moment each event is
   * sent.
   *
   * A function rather than a list, because windows open and close over the
   * life of a host and a list captured at `serve` time would be stale by the
   * second window. `() => BrowserWindow.getAllWindows().map((w) => w.webContents)`
   * is the whole of it for most apps.
   */
  renderers: () => Iterable<WebContents>;
}

export interface ElectronLocalHost {
  readonly engine: LocalEngine;
  readonly store: LocalStore;
  /** Where the store's database file is. */
  readonly path: string;
  /**
   * Whether this host may write.
   *
   * False when another engine already holds the store — another window in
   * another process, or a second host in this one. **This is the engine's own
   * writer lock and is not Electron's single-instance lock.** They answer
   * different questions and an app can want both: the single-instance lock
   * decides whether a second copy of the application starts at all, while
   * this decides which handle over one store file may advance its cursor.
   * Holding the first does not give you the second, because one application
   * can legitimately open two stores, and neither gives you the other's
   * guarantee.
   */
  readonly writer: boolean;
  /**
   * Answer a renderer's calls and push it events. Returns the function that
   * stops both, which {@link close} also calls — an application that only
   * ever tears the host down does not have to hold it.
   */
  serve(options: ServeOptions): () => void;
  /** Stop serving, stop the engine and close the store. Idempotent. */
  close(): void;
}

/**
 * The `webPreferences` a renderer reaching the engine must be given.
 *
 * Exported so the three flags are set from one place rather than copied into
 * each `BrowserWindow`. Every one of them is load-bearing and none announces
 * itself when it is wrong: with `sandbox` off the renderer gets a Node
 * environment it has no use for, with `contextIsolation` off the page's own
 * scripts share a context with the preload, and with `nodeIntegration` on the
 * page can open the store directly and become a second writer the engine's
 * lock was built to refuse.
 *
 * `satisfies` rather than a bare object: it is checked against Electron's own
 * `WebPreferences`, so a renamed or removed flag fails the build here rather
 * than being silently ignored at runtime, which is what Electron does with a
 * `webPreferences` key it does not recognize.
 */
export function sandboxedWebPreferences(
  preload: string,
): WebPreferences & { preload: string } {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  } satisfies WebPreferences;
}

/** A renderer named something the host does not serve. */
class UnknownMethodError extends Error {
  constructor(method: string) {
    super(
      `@withmarfa/sdk/electron: the renderer asked for '${method}', which this host does not serve. ` +
        `The bridge publishes a closed set of methods; anything outside it is refused rather than reached.`,
    );
    this.name = "UnknownMethodError";
  }
}

/** A renderer's argument that is not the shape the method takes. */
function badArgument(method: string, position: number, wanted: string): Error {
  const error = new Error(
    `@withmarfa/sdk/electron: '${method}' wants ${wanted} in position ${String(position)}.`,
  );
  error.name = "BadArgumentError";
  return error;
}

function badField(method: string, field: string, wanted: string): Error {
  const error = new Error(
    `@withmarfa/sdk/electron: '${method}' wants ${wanted} for '${field}'.`,
  );
  error.name = "BadArgumentError";
  return error;
}

/**
 * Arguments arrive from the renderer, so they are checked rather than
 * trusted.
 *
 * Coarsely, and deliberately so: the store refuses a write it cannot make and
 * says why, so a full schema per method would restate the engine's own
 * validation in a second place that could disagree with it. What is worth
 * catching here is the shape that would otherwise fail somewhere unrecognizable
 * — an id that is not a string reaching a query builder — rather than a
 * property bag the type registry has an opinion about.
 */
function asString(method: string, args: unknown[], position: number): string {
  const value = args[position];
  if (typeof value !== "string")
    throw badArgument(method, position, "a string");
  return value;
}

function asRecord(
  method: string,
  args: unknown[],
  position: number,
): Record<string, unknown> {
  const value = args[position];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badArgument(method, position, "an object");
  }
  return value as Record<string, unknown>;
}

/**
 * The string fields inside a create, checked the way an id argument is.
 *
 * The outer object was checked and its contents were not, which left exactly
 * the case this boundary's own reasoning names: `{ type, properties, id: 42 }`
 * reached `outbox.enqueue({ targetId: 42 })`. The required names must be
 * present and strings; the optional ones must be strings when they are there
 * at all.
 */
function checkStringFields(
  method: string,
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const field of required) {
    if (typeof input[field] !== "string" || input[field] === "") {
      throw badField(method, field, "a non-empty string");
    }
  }
  for (const field of optional) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw badField(method, field, "a string when it is given");
    }
  }
}

type Handler = (host: ElectronLocalHost, args: unknown[]) => Promise<unknown>;

/**
 * What each published method does.
 *
 * `Record<LocalMethod, Handler>` rather than a plain object: `LocalMethod` is
 * derived from the renderer's contract, so a method added there and not
 * handled here fails to compile. The reverse — a handler for a method the
 * contract does not name — is also a type error, which is what keeps the
 * reachable set and the published set the same set.
 */
const HANDLERS: Record<LocalMethod, Handler> = {
  start: async (host) => host.engine.start(),
  // The one method the engine answers synchronously. It still crosses the
  // boundary as a promise, because the boundary is what makes it one.
  stop: (host) => {
    host.engine.stop();
    return Promise.resolve();
  },
  drain: async (host) => host.engine.drain(),
  status: async (host) => host.engine.status(),

  getItem: async (host, args) =>
    host.store.visible.getItem(asString("getItem", args, 0)),
  listItems: async (host, args) => {
    const filters = args[0];
    return filters === undefined || filters === null
      ? host.store.visible.listItems()
      : host.store.visible.listItems(asRecord("listItems", args, 0));
  },
  getEdge: async (host, args) =>
    host.store.visible.getEdge(asString("getEdge", args, 0)),
  listEdges: async (host) => host.store.visible.listEdges(),
  getMetadata: async (host, args) =>
    host.store.visible.getMetadata(asString("getMetadata", args, 0)),

  createItem: async (host, args) => {
    const input = asRecord("createItem", args, 0);
    checkStringFields(
      "createItem",
      input,
      ["type"],
      ["id", "timestamp", "source_id", "tier"],
    );
    if (
      typeof input.properties !== "object" ||
      input.properties === null ||
      Array.isArray(input.properties)
    ) {
      throw badField("createItem", "properties", "an object");
    }
    return host.store.mutations.createItem(
      input as unknown as Parameters<LocalStore["mutations"]["createItem"]>[0],
    );
  },
  updateItem: async (host, args) =>
    host.store.mutations.updateItem(
      asString("updateItem", args, 0),
      asRecord("updateItem", args, 1),
    ),
  deleteItem: async (host, args) =>
    host.store.mutations.deleteItem(asString("deleteItem", args, 0)),
  createEdge: async (host, args) => {
    const input = asRecord("createEdge", args, 0);
    checkStringFields(
      "createEdge",
      input,
      ["source_id", "target_id", "edge_type"],
      ["id"],
    );
    return host.store.mutations.createEdge(
      input as unknown as Parameters<LocalStore["mutations"]["createEdge"]>[0],
    );
  },
  updateEdge: async (host, args) =>
    host.store.mutations.updateEdge(
      asString("updateEdge", args, 0),
      asRecord("updateEdge", args, 1),
    ),
  deleteEdge: async (host, args) =>
    host.store.mutations.deleteEdge(asString("deleteEdge", args, 0)),

  listDeadLetters: async (host) => host.store.deadLetters.list(),
};

/** A refusal, as something that survives a process boundary. */
function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

/**
 * Open the store for this identity and build the engine over it.
 *
 * The store lives under `userData`, keyed on all three parts of the identity,
 * so signing a second account in on one machine gives it a store of its own
 * rather than meeting the engine's refusal to open one account's store as
 * another.
 */
export async function openElectronLocalStore(
  options: ElectronLocalHostOptions,
): Promise<ElectronLocalHost> {
  const { userData, identity, client } = options;
  const path = localStorePath({ userData, identity });

  // Made before the store is opened, not left to it. The layout under
  // `userData` is this host's, so making it is this host's job — and it
  // means the store is opened against a path that exists whatever any
  // dependency does about a missing parent. A first launch is the one time
  // it is absent, which is also the one time nobody is watching, so the
  // property is pinned by a test rather than left to this comment.
  mkdirSync(localStoreDirectory({ userData, identity }), { recursive: true });

  const store = await openLocalStore({
    path,
    identity,
    ...(options.onRecovery === undefined
      ? {}
      : { onRecovery: options.onRecovery }),
  });

  const engine = createLocalEngine({
    store,
    client,
    ...(options.retryCeiling === undefined
      ? {}
      : { retryCeiling: options.retryCeiling }),
    ...(options.initialRetryMs === undefined
      ? {}
      : { initialRetryMs: options.initialRetryMs }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  });

  /**
   * How to stop serving, held so `close` can do it.
   *
   * Electron refuses a second `handle` on one channel, so a host that leaves
   * its handler behind makes the next host over that `ipcMain` — signing in
   * as a second account, or a teardown and rebuild — throw where nothing is
   * looking. Returned from `serve` as well, for a caller that wants to stop
   * serving without closing the store.
   */
  let stopServing: (() => void) | undefined;
  let closed = false;

  const host: ElectronLocalHost = {
    engine,
    store,
    path,
    writer: store.writer,

    serve: ({ ipcMain, renderers }: ServeOptions) => {
      const stopListening = engine.on((event) => {
        const forWire = forRenderer(event);
        for (const renderer of renderers()) {
          // Each renderer separately: one window that has been destroyed
          // between the read and the send must not stop the others being
          // told. Electron throws on a destroyed `webContents`, and an event
          // is a notification rather than a transaction — there is nothing
          // to roll back and nobody to report the throw to.
          try {
            renderer.send(LOCAL_EVENT_CHANNEL, forWire);
          } catch {
            // The window is gone. Nothing to do and nothing to say.
          }
        }
      });

      ipcMain.handle(
        LOCAL_INVOKE_CHANNEL,
        // Always resolves, never rejects. A rejection out of `handle`
        // reaches the renderer as a string with the class stripped off it,
        // and an app that cannot tell a read-only store from a missing item
        // cannot say anything useful to the person in front of it.
        async (
          _event: IpcMainInvokeEvent,
          request: unknown,
        ): Promise<InvokeResult> => {
          const { method, args } = (request ?? {}) as Partial<InvokeRequest>;
          try {
            // One coercion, and the lookup indexes the same string the guard
            // checked. Two of them is a hole waiting for a `method` whose
            // `toString` does not agree with itself.
            const named = String(method);
            const handler = Object.prototype.hasOwnProperty.call(
              HANDLERS,
              named,
            )
              ? HANDLERS[named as LocalMethod]
              : undefined;
            if (handler === undefined) throw new UnknownMethodError(named);
            return { ok: true, value: await handler(host, args ?? []) };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        },
      );

      const stop = (): void => {
        if (stopServing !== stop) return;
        stopServing = undefined;
        stopListening();
        ipcMain.removeHandler(LOCAL_INVOKE_CHANNEL);
      };
      stopServing = stop;
      return stop;
    },

    close: () => {
      // Idempotent, because two ordinary paths reach it: `window-all-closed`
      // and whatever the application does on its own way out. An application
      // should not have to remember which one ran.
      if (closed) return;
      closed = true;
      stopServing?.();
      engine.stop();
      store.close();
    },
  };

  return host;
}
