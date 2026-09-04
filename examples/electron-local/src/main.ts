import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { MarfaClient } from "@withmarfa/sdk";
import {
  openElectronLocalStore,
  sandboxedWebPreferences,
} from "@withmarfa/sdk/electron";
import type { ElectronLocalHost } from "@withmarfa/sdk/electron";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "@withmarfa/sdk/local";

/**
 * The main process: it owns the store, and it is the only thing that does.
 *
 * The renderer is sandboxed and has no Node at all, so everything it can do
 * to the engine goes through the bridge in `preload.ts`. That is not a
 * hardening exercise on top of a working design; it is the design. A renderer
 * with Node could open the store itself and become a second writer over one
 * file, which is the thing the engine's lock exists to refuse.
 */

/**
 * Where this store belongs, and it is the identity rather than the
 * connection.
 *
 * All three are read from the environment so the sample can be pointed at a
 * real server, and all three have a default so it runs with nothing set —
 * which is the state it is meant to be tried in. A store keyed on a different
 * origin, space or account is a different store on disk.
 */
const identity = {
  origin: process.env.MARFA_API_URL ?? "http://localhost:8600",
  spaceId: process.env.MARFA_SPACE_ID ?? SINGLE_SPACE,
  accountId: process.env.MARFA_ACCOUNT_ID ?? SINGLE_ACCOUNT,
};

/**
 * Electron's single-instance lock, which is not the engine's writer lock.
 *
 * They are orthogonal and both matter, and conflating them is easy because
 * both are called a lock and both are about "only one". This one decides
 * whether a second copy of the **application** starts at all: without it, a
 * user double-clicking the icon twice gets two processes, and the second
 * would find the store held and open it read-only — an app that looks
 * identical to the first and silently cannot save.
 *
 * The engine's lock is the other half and cannot be replaced by this one. It
 * is per store file rather than per application, so it still refuses a second
 * writer when one process opens the same store twice, and it still permits
 * two stores in one process, which is what a second signed-in account is.
 * Holding this lock does not make a store writable, and holding the store
 * does not stop a second application starting.
 */
const isOnlyInstance = app.requestSingleInstanceLock();

let host: ElectronLocalHost | undefined;

async function start(): Promise<void> {
  host = await openElectronLocalStore({
    userData: app.getPath("userData"),
    identity,
    // The engine takes a client whether or not there is a server to reach.
    // Nothing below calls `engine.start()` unless a key is configured, so
    // with no key this application never makes a request — which is the whole
    // point of it.
    client: new MarfaClient({
      url: identity.origin,
      apiKey: process.env.MARFA_API_KEY ?? "marfa_k1_offline",
    }),
  });

  host.serve({
    ipcMain,
    // Read per event rather than captured, so a window opened later is told
    // and a window closed earlier is not looked for.
    renderers: () => BrowserWindow.getAllWindows().map((w) => w.webContents),
  });

  const window = new BrowserWindow({
    width: 760,
    height: 620,
    title: "Marfa local engine",
    webPreferences: sandboxedWebPreferences(
      fileURLToPath(new URL("./preload.cjs", import.meta.url)),
    ),
  });
  await window.loadFile(
    fileURLToPath(new URL("../app/index.html", import.meta.url)),
  );

  // Only with a real credential. Started without one the engine would spend
  // its life in backoff against a server that is not there, and the sample is
  // about what an application can do while that is true.
  if (process.env.MARFA_API_KEY !== undefined) {
    await host.engine.start();
  }
}

// Everything below is the first instance's, and the `else` is load-bearing
// rather than a style. `app.quit()` asks the application to quit; it does not
// stop this module evaluating, so a second instance that only called it went
// straight on to open the store the first one is holding — arriving at the
// read-only window this lock exists to prevent, through the code that takes
// the lock. Nothing in `quit()`'s signature says so, and Electron's own
// documented shape for this is the same `else`.
if (!isOnlyInstance) {
  app.quit();
} else {
  // The first instance is told when a second is refused. A user who
  // double-clicked twice should get the window they already have rather than
  // nothing happening at all.
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      // Nothing else is going to say this. A failure here leaves a window
      // that never appeared and a process that never exits.
      console.error("could not start:", error);
      app.exit(1);
    });
}

app.on("window-all-closed", () => {
  // Closed rather than left to the process exiting, so the writer lock is
  // released and the next launch is a writer. `close` also gives the IPC
  // channel back, which is why the stop function `serve` returns is not held
  // here. The macOS convention of staying resident is skipped deliberately:
  // this sample is read by relaunching it.
  host?.close();
  app.quit();
});
