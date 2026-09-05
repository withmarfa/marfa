import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { MarfaClient } from "../client.js";
import type { StoreIdentity } from "../local/types.js";
import {
  LOCAL_INVOKE_CHANNEL,
  LOCAL_METHODS,
  forRenderer,
  refusalNameOf,
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
 * What `contextBridge` leaves of a rejection.
 *
 * Electron does not hand the renderer the preload's Error object: it
 * serializes what it can and rebuilds one in the renderer's realm. Custom
 * properties do not survive that, and `error.name = "..."` on an instance is
 * a custom property — it shadows the prototype's rather than replacing it.
 * `message` does survive, which is why the class travels there.
 *
 * Modelled rather than reached for real, and the modelling is the point: a
 * harness where both halves share a realm has no such boundary, so a test
 * that read `.name` off the caught error would pass while the application
 * failed.
 */
function acrossContextBridge(error: Error | undefined): Error | undefined {
  if (error === undefined) return undefined;
  const rebuilt = new Error(error.message);
  rebuilt.stack = error.stack;
  return rebuilt;
}

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
      // Electron refuses a second handler on one channel, and a harness that
      // accepted one would hide a host that never removes its own.
      if (handlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        );
      }
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

    // The one that matters: the class an app keys on to decide what to put
    // in front of a person. A second host over the same store is a reader,
    // and every write through its bridge refuses.
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

    // Through `contextBridge`, not beside it. Electron rebuilds a thrown
    // Error in the renderer's realm from the fields it serializes, and a
    // `name` assigned on an instance is an own property rather than the
    // prototype's — so it does not make the trip. Reading `.name` here
    // would pass in this harness, where both halves share a realm, and
    // would be wrong in the application: the mechanism that destroys the
    // name is the one thing the harness does not have.
    expect(refusalNameOf(acrossContextBridge(readOnly))).toBe(
      "ReadOnlyStoreError",
    );
    expect(refusalNameOf(acrossContextBridge(refusal))).toBe("Error");
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

describe("what the host refuses from a renderer", () => {
  it("refuses a create whose id is not a string", async () => {
    // The boundary's own comment names "an id that is not a string reaching
    // a query builder" as the thing worth catching, and the first version of
    // this checked the outer object and none of the fields inside it — so a
    // number went straight through to the outbox as a target id.
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    await expect(
      bridge.createItem({
        type: "core.note",
        properties: {},
        id: 42 as unknown as string,
      }),
    ).rejects.toThrow(/id/);
    expect(await bridge.listItems()).toEqual([]);
  });

  it("refuses a create with no type", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    await expect(
      bridge.createItem({ properties: {} } as unknown as {
        type: string;
        properties: Record<string, unknown>;
      }),
    ).rejects.toThrow(/type/);
  });

  it("refuses an edge whose endpoints are not strings", async () => {
    const opened = await host(userDataDir());
    const { ipcMain, ipcRenderer, renderer } = ipcPair();
    opened.serve({ ipcMain, renderers: () => [renderer] });
    const bridge = createLocalBridge(ipcRenderer);

    await expect(
      bridge.createEdge({
        source_id: 1 as unknown as string,
        target_id: "itm_b",
        edge_type: "references",
      }),
    ).rejects.toThrow(/source_id/);
  });
});

describe("a host that has been closed", () => {
  it("gives the channel back, so a replacement host can take it", async () => {
    // Signing out and back in as another account is a second host over one
    // `ipcMain`. Electron refuses a second handler on a channel, so a host
    // that does not remove its own on close makes that the last thing the
    // application ever does.
    const userData = userDataDir();
    const first = await host(userData);
    const pair = ipcPair();
    first.serve({ ipcMain: pair.ipcMain, renderers: () => [pair.renderer] });
    first.close();
    open.splice(open.indexOf(first), 1);

    const second = await host(userData);
    expect(() => {
      second.serve({ ipcMain: pair.ipcMain, renderers: () => [pair.renderer] });
    }).not.toThrow();
    expect((await createLocalBridge(pair.ipcRenderer).status()).writer).toBe(
      true,
    );
  });

  it("can be closed twice", async () => {
    // `window-all-closed` and an explicit teardown both reach for it, and an
    // application should not have to remember which one ran.
    const opened = await host(userDataDir());
    opened.close();
    open.splice(open.indexOf(opened), 1);
    expect(() => {
      opened.close();
    }).not.toThrow();
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

  it("leaves no second way into the renderer", () => {
    // Absence, which is the half a positive assertion cannot state. Each of
    // these re-opens what `sandbox` and `contextIsolation` close: a subframe
    // or a <webview> carrying Node is a renderer that can open the store
    // directly and become a second writer, and none of them announces
    // itself.
    // Named one at a time against Electron's own `WebPreferences` rather
    // than looked up in a list of strings: a flag Electron renames stops
    // compiling here, where a string would go on passing about a key that no
    // longer exists.
    const preferences = sandboxedWebPreferences("/app/dist/preload.cjs");
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.nodeIntegrationInSubFrames ?? false).toBe(false);
    expect(preferences.nodeIntegrationInWorker ?? false).toBe(false);
    expect(preferences.webviewTag ?? false).toBe(false);
  });
});
