/**
 * A real browser, and a real listener for the app under test, for the tests
 * that must see a page the way a person does: scripts running, the form's
 * submit state, Back and Forward.
 *
 * A request made through `app.request` shows what the server sent. It cannot
 * show that the page works once a browser has run it, which is where the
 * defects these tests hold were found.
 *
 * The browser is whichever the machine already has. None is downloaded: a
 * test run must not need a network or write outside its own directories.
 */
import { existsSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { TestApp } from "./test-utils.js";

/** Where a Chromium build may already be installed on this machine. */
function chromiumCandidates(): string[] {
  const candidates: string[] = [];
  const named = process.env.MARFA_TEST_BROWSER;
  if (named) candidates.push(named);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root).sort().reverse()) {
      if (entry.startsWith("chromium-")) {
        candidates.push(join(root, entry, "chrome-linux", "chrome"));
      }
    }
  }
  return candidates.filter((path) => existsSync(path));
}

/**
 * Launch a browser, or answer `null` when the machine has none.
 *
 * A machine with none is a developer's laptop on a plane; the caller skips
 * there. CI has Google Chrome installed, so a caller treats `null` as a
 * failure when `CI` is set rather than reporting a green run that looked at
 * nothing.
 */
export async function launchTestBrowser(): Promise<Browser | null> {
  // Playwright turns the back-forward cache off by default, and with it off
  // Back reloads the page, which hides exactly what a person with a browser's
  // ordinary settings meets: the page restored as it was left.
  const options = { ignoreDefaultArgs: ["--disable-back-forward-cache"] };
  for (const executablePath of chromiumCandidates()) {
    try {
      return await chromium.launch({ ...options, executablePath });
    } catch {
      // Try the next one.
    }
  }
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch {
    return null;
  }
}

/** A port nothing is listening on, found by asking the system for one. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("freePort: no port assigned"));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

/** The address a test app must be built to answer at, before it exists. */
export async function reserveOrigin(): Promise<{
  origin: string;
  port: number;
}> {
  const port = await freePort();
  return { origin: `http://127.0.0.1:${String(port)}`, port };
}

/**
 * Listen for `app` on the port `reserveOrigin` named. The app has to have
 * been built with that origin as its `authBaseUrl`, because sign-in cookies
 * and the origin check both compare against it.
 */
export function listen(
  app: TestApp,
  port: number,
  /** Answers for addresses the app does not own, such as an app's callback. */
  also?: (request: Request) => Response | undefined,
): { close: () => Promise<void> } {
  const server = serve({
    fetch: (request) => also?.(request) ?? app.fetch(request),
    port,
    hostname: "127.0.0.1",
  });
  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        (server as Server).closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
