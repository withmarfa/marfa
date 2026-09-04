import { contextBridge, ipcRenderer } from "electron";
import { LOCAL_BRIDGE_KEY } from "../protocol.js";
import { createLocalBridge } from "./bridge.js";

/**
 * The preload half of the engine's Electron host.
 *
 * Its own entry, separate from `@withmarfa/sdk/electron`, because a
 * sandboxed preload cannot load what the main-process half imports. A
 * sandboxed preload has no filesystem `require`: it has to be bundled into
 * one file, and bundling the main-process entry would pull `@libsql/client`
 * and `drizzle-orm` — a native addon among them — into a context that could
 * not load them even if the bundler managed to inline them. Nothing on this
 * side of the boundary touches the store; it forwards.
 *
 * The bundling is the application's job either way. Electron resolves a
 * sandboxed preload's `require` against `electron` and a few builtins and
 * nothing else, so a preload that imports this package by name works only
 * once a bundler has inlined it. It also has to come out as CommonJS:
 * Electron loads an ES-module preload only when the renderer is not
 * sandboxed, which is the setting this whole arrangement exists to keep on.
 */

/**
 * Put the engine on `window` under {@link LOCAL_BRIDGE_KEY}.
 *
 * One line is the whole preload for most apps. `contextBridge` is what makes
 * the renderer's copy a set of proxies rather than the object itself, so the
 * page's own scripts cannot reach past the published methods into the
 * preload's context.
 */
export function exposeLocalBridge(): void {
  contextBridge.exposeInMainWorld(
    LOCAL_BRIDGE_KEY,
    createLocalBridge(ipcRenderer),
  );
}

export { createLocalBridge } from "./bridge.js";
export type { IpcRendererLike } from "./bridge.js";
export {
  LOCAL_BRIDGE_KEY,
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  PLAIN_REFUSAL,
  refusalNameOf,
} from "../protocol.js";
export type { BridgeEngineEvent, MarfaLocalBridge } from "../protocol.js";
