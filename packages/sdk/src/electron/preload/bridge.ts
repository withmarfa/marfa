import {
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  PLAIN_REFUSAL,
} from "../protocol.js";
import type {
  BridgeEngineEvent,
  InvokeResult,
  MarfaLocalBridge,
} from "../protocol.js";

/**
 * The part of Electron's `ipcRenderer` the bridge uses.
 *
 * Narrow so a test can drive the bridge against the host with two plain
 * objects instead of an Electron process, which is the only way the halves
 * can be checked against each other at all: a channel the host registers and
 * the bridge never calls is green in both files and blank in the app.
 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void;
}

/**
 * Put the name back on a refusal that crossed the boundary as data.
 *
 * Into the **message**, because that is the only field that reaches the
 * renderer. `contextBridge` does not hand the page the preload's Error: it
 * rebuilds one in the page's realm from what it can serialize, and a `name`
 * assigned on an instance is a custom own property that is not part of that.
 * A subclass does no better, since the prototype does not cross either. So
 * the class is written into the message and read back with
 * {@link refusalNameOf}.
 *
 * `.name` is still set, for the case where nothing is lost: an unsandboxed
 * preload, or an application calling {@link createLocalBridge} directly. It
 * is a convenience there and is never the thing to rely on.
 */
function rethrow(result: InvokeResult): never {
  if (result.ok) throw new Error("not a refusal");
  const { name, message } = result.error;
  // An ordinary failure is not dressed up. Prefixing every message with
  // `Error: ` would put a word in front of each one that says nothing.
  const error = new Error(
    name === PLAIN_REFUSAL ? message : `${name}: ${message}`,
  );
  error.name = name;
  throw error;
}

/**
 * Build the object a sandboxed renderer sees.
 *
 * Separate from the `contextBridge` call so the shape can be checked without
 * Electron, and so an app that wants the engine under a different global — or
 * merged into an API of its own — can take it without reimplementing the
 * calls.
 */
export function createLocalBridge(
  ipcRenderer: IpcRendererLike,
): MarfaLocalBridge {
  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    const result = (await ipcRenderer.invoke(LOCAL_INVOKE_CHANNEL, {
      method,
      args,
    })) as InvokeResult;
    if (!result.ok) rethrow(result);
    return result.value;
  };

  return {
    start: async () => {
      await call("start");
    },
    stop: async () => {
      await call("stop");
    },
    drain: async () => {
      await call("drain");
    },
    status: async () =>
      (await call("status")) as Awaited<ReturnType<MarfaLocalBridge["status"]>>,

    getItem: async (id) =>
      (await call("getItem", id)) as Awaited<
        ReturnType<MarfaLocalBridge["getItem"]>
      >,
    listItems: async (filters) =>
      (await call("listItems", filters)) as Awaited<
        ReturnType<MarfaLocalBridge["listItems"]>
      >,
    getEdge: async (id) =>
      (await call("getEdge", id)) as Awaited<
        ReturnType<MarfaLocalBridge["getEdge"]>
      >,
    listEdges: async () =>
      (await call("listEdges")) as Awaited<
        ReturnType<MarfaLocalBridge["listEdges"]>
      >,
    getMetadata: async (itemId) =>
      (await call("getMetadata", itemId)) as Awaited<
        ReturnType<MarfaLocalBridge["getMetadata"]>
      >,

    createItem: async (input) =>
      (await call("createItem", input)) as Awaited<
        ReturnType<MarfaLocalBridge["createItem"]>
      >,
    updateItem: async (id, properties) =>
      (await call("updateItem", id, properties)) as Awaited<
        ReturnType<MarfaLocalBridge["updateItem"]>
      >,
    deleteItem: async (id) => {
      await call("deleteItem", id);
    },
    createEdge: async (input) =>
      (await call("createEdge", input)) as Awaited<
        ReturnType<MarfaLocalBridge["createEdge"]>
      >,
    updateEdge: async (id, properties) =>
      (await call("updateEdge", id, properties)) as Awaited<
        ReturnType<MarfaLocalBridge["updateEdge"]>
      >,
    deleteEdge: async (id) => {
      await call("deleteEdge", id);
    },

    listDeadLetters: async () =>
      (await call("listDeadLetters")) as Awaited<
        ReturnType<MarfaLocalBridge["listDeadLetters"]>
      >,

    on: (listener: (event: BridgeEngineEvent) => void) => {
      const relay = (_event: unknown, ...args: unknown[]): void => {
        listener(args[0] as BridgeEngineEvent);
      };
      ipcRenderer.on(LOCAL_EVENT_CHANNEL, relay);
      return () => {
        ipcRenderer.removeListener(LOCAL_EVENT_CHANNEL, relay);
      };
    },
  };
}
