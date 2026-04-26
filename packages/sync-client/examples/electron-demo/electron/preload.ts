/**
 * Preload script. Exposes a minimal API to the renderer via
 * `contextBridge.exposeInMainWorld`. The renderer constructs the
 * MymeSyncClient itself; the preload only needs to surface the API
 * key (in a real app, fetched from the keychain via `keytar`).
 */

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("mymeAuth", {
  // For the demo we read from environment vars set when launching;
  // a real app reads from `keytar.getPassword('myme.sync-client', 'default')`
  // in the main process and exposes the result here.
  getApiKey: () => process.env.MYME_API_KEY ?? "",
  getApiUrl: () => process.env.MYME_API_URL ?? "http://localhost:8602",
  // Indicates whether the host successfully provided a key — the demo
  // surfaces a "Sign in" UI when this returns false.
  hasCredentials: () => Boolean(process.env.MYME_API_KEY),
});
