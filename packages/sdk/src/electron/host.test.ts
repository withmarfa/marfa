import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { MarfaClient } from "../client.js";
import type { StoreIdentity } from "../local/types.js";
import {
  LOCAL_BRIDGE_KEY,
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  LOCAL_METHODS,
  forRenderer,
} from "./protocol.js";
import type { BridgeEngineEvent, InvokeResult } from "./protocol.js";
import { openElectronLocalStore, sandboxedWebPreferences } from "./host.js";
import type { ElectronLocalHost } from "./host.js";
import { createLocalBridge } from "./preload/bridge.js";
import { localStorePath } from "./store-path.js";

/**
 * A client pointed at a port nothing is listening on.
 *
 * The engine takes one whether or not it is going to talk to a server, and
 * every test here is about what the app can do while it cannot. Nothing
 * below calls `start`, so no request is ever made — a client reaching a real
 * server would make these tests prove less, not more.
 */
function offlineClient(): MarfaClient {
  return new MarfaClient({
    url: "http://127.0.0.1:1",
    apiKey: "marfa_k1_test",
  });
}

const roots: string[] = [];
const open: ElectronLocalHost[] = [];

function userDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-electron-host-"));
  roots.push(dir);
  return dir;
}

function identity(overrides: Partial<StoreIdentity> = {}): StoreIdentity {
  return {
    origin: "https://api.marfa.so",
    spaceId: "spc_alpha",
    accountId: "acc_one",
    ...overrides,
  };
}

async function host(
  userData: string,
  who: StoreIdentity = identity(),
): Promise<ElectronLocalHost> {
  const opened = await openElectronLocalStore({
    userData,
    identity: who,
    client: offlineClient(),
  });
  open.push(opened);
  return opened;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in for the pair Electron puts either side of the boundary.
 *
 * The two halves of this subpath are only correct together — a channel name
 * the main process registers and the preload does not call is green in both
 * files and broken in the app — so the tests drive them through one fake
 * that connects them, rather than asserting on each half's idea of the
 * contract.
 */
function ipcPair(): {
  ipcMain: IpcMain;
  ipcRenderer: Parameters<typeof createLocalBridge>[0];
  renderer: WebContents;
  invokeRaw: (request: unknown) => Promise<InvokeResult>;
} {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const ipcMain = {
    handle: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;

  const invokeRaw = async (request: unknown): Promise<InvokeResult> => {
    const handler = handlers.get(LOCAL_INVOKE_CHANNEL);
    if (handler === undefined) throw new Error("nothing is serving");
    return (await handler({}, request)) as InvokeResult;
  };

  const ipcRenderer = {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        return Promise.reject(
          new Error(`no handler registered for '${channel}'`),
        );
      }
      return Promise.resolve(handler({}, ...args));
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (
      channel: string,
      listener: (...args: unknown[]) => void,
    ) => {
      listeners.get(channel)?.delete(listener);
    },
  };

  const renderer = {
    send: (channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? [])
        listener({}, ...args);
    },
  } as unknown as WebContents;

  return { ipcMain, ipcRenderer, renderer, invokeRaw };
}

describe("the Electron main-process host", () => {
  it("makes the store's directory, so a first launch can write", async () => {
    const userData = userDataDir();
    const opened = await host(userData);
    expect(opened.path).toBe(
      localStorePath({ userData, identity: identity() }),
    );
    expect(existsSync(opened.path)).toBe(true);
    // The half that is not about the file existing. A first launch is the one
    // time the directory is absent, and a store opened before it exists comes
    // back read-only with nothing thrown and no lockfile written — an app
    // that never wrote, and a second launch that works.
    expect(opened.writer).toBe(true);
  });

  it("gives a second account on one machine its own store", async () => {
    // The engine refuses to open a store as an identity it does not belong
    // to, and that refusal is correct. The host's job is to make sure the
    // second account never meets it, by putting it somewhere of its own.
    const userData = userDataDir();
    const first = await host(userData, identity({ accountId: "acc_one" }));
    const second = await host(userData, identity({ accountId: "acc_two" }));

    expect(second.path).not.toBe(first.path);
    expect(first.writer).toBe(true);
    expect(second.writer).toBe(true);
  });

  it("writes with no network", async () => {
    const opened = await host(userDataDir());
    await opened.store.mutations.createItem({
      type: "core.note",
      properties: { title: "written offline" },
    });
    const held = await opened.store.visible.listItems();
    expect(held.map((item) => item.properties.title)).toEqual([
      "written offline",
    ]);
  });

  it("still holds the write after the host is closed and opened again", async () => {
    const userData = userDataDir();
    const first = await host(userData);
    await first.store.mutations.createItem({
      type: "core.note",
      properties: { title: "survives a restart" },
    });
    first.close();
    open.splice(open.indexOf(first), 1);

    const second = await host(userData);
    const held = await second.store.visible.listItems();
    expect(held.map((item) => item.properties.title)).toEqual([
      "survives a restart",
    ]);
    // Unsent, because nothing has been able to send it.
    expect((await second.engine.status()).pending).toBe(1);
  });
});

describe("the bridge between the host and a sandboxed renderer", () => {
  it("carries a write and a read across the boundary", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    await bridge.createItem({
      type: "core.note",
      properties: { title: "through the bridge" },
    });
    const held = await bridge.listItems();
    expect(held.map((item) => item.properties.title)).toEqual([
      "through the bridge",
    ]);
  });

  it("publishes every method the renderer's contract names, and no more", () => {
    // Two directions, and only one of them is a type error. A method on the
    // bridge that the host does not handle compiles cleanly on both sides
    // and fails when a person clicks something.
    const { ipcRenderer } = ipcPair();
    const bridge = createLocalBridge(ipcRenderer);
    const published = Object.keys(bridge)
      .filter((key) => key !== "on")
      .sort();
    expect(published).toEqual([...LOCAL_METHODS].sort());
  });

  it("refuses a method the host never published", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, renderer, invokeRaw } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });

    // `close` is a real method on the host and must not be reachable from a
    // renderer: the closed set is what keeps the boundary narrower than the
    // object behind it.
    const result = await invokeRaw({ method: "close", args: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("close");
  });

  it("carries the name of a refusal, not only its text", async () => {
    // An app tells "this window is not the writer" from "there is no such
    // item" by the class, and a rejection out of `ipcMain.handle` arrives as
    // a string with the class gone.
    const userData = userDataDir();
    const opened = await host(userData);
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    const refusal = await bridge
      .updateItem("itm_nothing", {})
      .then(() => undefined)
      .catch((error: unknown) => error as Error);
    expect(refusal?.message).toMatch(/no item itm_nothing/);

    // The one that matters: a class an app keys on to decide what to put in
    // front of a person, arriving as itself. A second host over the same
    // store is a reader, and every write through its bridge refuses.
    const reader = await host(userData);
    const readerPair = ipcPair();
    reader.serve({
      ipcMain: readerPair.ipcMain,
      renderers: () => [readerPair.renderer],
    });
    const readerBridge = createLocalBridge(readerPair.ipcRenderer);
    const readOnly = await readerBridge
      .createItem({ type: "core.note", properties: {} })
      .then(() => undefined)
      .catch((error: unknown) => error as Error);
    expect(readOnly?.name).toBe("ReadOnlyStoreError");
  });

  it("pushes engine events to the renderers it is given", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    const seen: BridgeEngineEvent[] = [];
    const stop = bridge.on((event) => seen.push(event));
    await opened.engine.drain();
    stop();

    expect(seen.map((event) => event.type)).toContain("drain.finished");
  });

  it("stops pushing once the renderer unsubscribes", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    const seen: BridgeEngineEvent[] = [];
    bridge.on((event) => seen.push(event))();
    await opened.engine.drain();

    expect(seen).toEqual([]);
  });

  it("stops answering once the host stops serving", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    const stopServing = opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    await bridge.status();
    stopServing();
    await expect(bridge.status()).rejects.toThrow(/no handler registered/);
  });

  it("does not send the thrown value a sync error carries", () => {
    // Everything on the event channel goes through structured clone, and
    // that field holds whatever was thrown. A value clone refuses takes the
    // send down with it, on the one path whose purpose is reporting a
    // failure without crashing.
    const stripped = forRenderer({
      type: "sync.error",
      scope: "stream",
      message: "the read did not finish",
      error: () => undefined,
    });
    expect(stripped).toEqual({
      type: "sync.error",
      scope: "stream",
      message: "the read did not finish",
    });
    expect(Object.keys(stripped)).not.toContain("error");
  });
});

describe("the engine's writer lock and Electron's single-instance lock", () => {
  it("makes a second handle on one store read-only, whatever the app did about second instances", async () => {
    // Two different questions. Electron's single-instance lock decides
    // whether a second copy of the application starts at all; this decides
    // which handle on one store may advance its cursor. An app can hold the
    // first and still open two windows, two accounts, or a second store, and
    // an app that holds neither still gets this one.
    const userData = userDataDir();
    const first = await host(userData);
    const second = await host(userData);

    expect(first.writer).toBe(true);
    expect(second.writer).toBe(false);
    await expect(second.engine.start()).rejects.toThrow(/read-only/);
  });
});

describe("the webPreferences a renderer reaching the engine must have", () => {
  it("gives no Node to the renderer and routes it through the preload", () => {
    const preferences = sandboxedWebPreferences("/app/dist/preload.cjs");
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.preload).toBe("/app/dist/preload.cjs");
  });

  it("names the channels and the global the two halves agree on", () => {
    // Constants rather than literals at either end. A renderer reading a
    // different global, or a preload sending on a different channel, is a
    // blank window with nothing in any log.
    expect(LOCAL_BRIDGE_KEY).toBe("marfaLocal");
    expect(LOCAL_INVOKE_CHANNEL).not.toBe(LOCAL_EVENT_CHANNEL);
  });
});
