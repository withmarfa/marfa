/**
 * Electron main process. Boots the BrowserWindow with a CSP that
 * allows WASM (PGlite ships WASM and Electron's default CSP blocks
 * `wasm-unsafe-eval`).
 *
 * In a real app you'd plumb `keytar` here to fetch the API key from
 * the OS keychain rather than hard-coding. The renderer-side wiring
 * works the same regardless.
 */

import { app, BrowserWindow, session } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function createWindow(): Promise<void> {
  // Allow WASM in our origin. Electron's default CSP otherwise blocks
  // wasm compilation, which breaks PGlite immediately.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' data: blob:",
        ],
      },
    });
  });

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

void app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
