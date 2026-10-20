/**
 * A real browser, and a real listener for the app under test, for the tests
 * that must see a page the way a person does: scripts running, the form's
 * submit state, Back and Forward.
 *
 * A request made through `app.request` shows what the server sent. It cannot
 * show that the page works once a browser has run it.
 *
 * The browser is whichever the machine already has. None is downloaded: a
 * test run must not need a network or write outside its own directories.
 */
import { existsSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { TestApp } from "./test-utils.js";

const MAC_APP = join(
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing",
);

/** The Chromium builds in a Playwright browsers folder, newest first. */
function builtIn(root: string): string[] {
  if (!existsSync(root)) return [];
  const revision = (entry: string): number =>
    Number(entry.slice("chromium-".length));
  return readdirSync(root)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => revision(b) - revision(a))
    .map((entry) => join(root, entry));
}

/**
 * Where a Chromium build may already be installed on this machine. On macOS
 * Playwright's own Chrome for Testing comes before the installed Google
 * Chrome, because launching that leaves a code-sign copy of the app each time
 * a test closes it.
 */
export function chromiumCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  arch: string = process.arch,
): string[] {
  const candidates: string[] = [];
  const named = env.MARFA_TEST_BROWSER;
  if (named) candidates.push(named);
  const root = env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === "darwin") {
    const build = arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
    const folder =
      root && existsSync(root)
        ? root
        : join(home, "Library", "Caches", "ms-playwright");
    for (const dir of builtIn(folder))
      candidates.push(join(dir, build, MAC_APP));
  } else if (root) {
    for (const dir of builtIn(root))
      candidates.push(join(dir, "chrome-linux", "chrome"));
  }
  return candidates.filter((path) => existsSync(path));
}

/**
 * Launch a browser, or answer why none would start.
 *
 * A machine with none is a developer's laptop on a plane; the caller skips
 * there. CI has Google Chrome installed, so a caller throws the error when
 * `CI` is set rather than reporting a green run that looked at nothing.
 */
export async function launchTestBrowser(): Promise<Browser | Error> {
  // Playwright turns the back-forward cache off by default, and with it off
  // Back reloads the page, which hides exactly what a person with a browser's
  // ordinary settings meets: the page restored as it was left.
  const options = { ignoreDefaultArgs: ["--disable-back-forward-cache"] };
  const failures: Error[] = [];
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));
  for (const executablePath of chromiumCandidates()) {
    try {
      return await chromium.launch({ ...options, executablePath });
    } catch (error) {
      failures.push(asError(error));
    }
  }
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch (error) {
    failures.push(asError(error));
  }
  return new Error("no browser would start", { cause: failures });
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
    // The adapter's environment carries the connection, which is where the
    // server reads the caller's address from, as it does in production.
    fetch: (request, env) => also?.(request) ?? app.fetch(request, env),
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
