import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

/**
 * Spawns the worktree's `@mymehq/server` against Atlas Postgres
 * + Atlas Electric, in a separate Node process. The harness owns the
 * lifecycle: `start()` resolves once the server's `/openapi.json`
 * responds; `stop()` SIGTERMs and awaits exit.
 *
 * Why spawn a subprocess instead of importing `createApp`?
 *   - The server entrypoint reads env synchronously at module load
 *     (`loadConfig`), and the integration tests need different env
 *     than the unit tests.
 *   - Subprocess isolation matches what apps do in production —
 *     `serve` from @hono/node-server attaches a real socket. Tests
 *     drive the public HTTP surface, not in-process Hono.
 *   - We can kill the child to simulate offline scenarios cleanly
 *     (the dance the offline integration test performs).
 */

export interface SpawnedServer {
  url: string;
  /** Send SIGTERM and resolve once the child has exited. */
  stop: () => Promise<void>;
  /** PID of the child, useful for diagnostics. */
  pid: number;
}

export interface StartServerOptions {
  port: number;
  databaseUrl: string;
  electricUrl: string;
  salt: string;
  /** Surface stdout / stderr to the test log? Defaults false. */
  verbose?: boolean;
}

/**
 * Resolve the path to `packages/server/src/index.ts` from the
 * sync-client package. The test runs with cwd somewhere under the
 * repo, but the path is stable relative to this file.
 */
function serverEntryPath(): string {
  // tests/integration/helpers → packages/sync-client/tests/...
  // four levels up from this file's compile-time location lands at
  // the worktree root; from there we descend to packages/server/src/index.ts.
  // We use process.cwd() of the calling test, with a fallback.
  const pkgRoot = resolve(import.meta.dirname, "..", "..", "..");
  return resolve(pkgRoot, "..", "server", "src", "index.ts");
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/openapi.json`);
      if (res.ok) return;
      lastError = new Error(`status ${String(res.status)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(
    `server at ${url} did not become healthy within ${String(timeoutMs)}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function startMymeServer(
  options: StartServerOptions,
): Promise<SpawnedServer> {
  const url = `http://127.0.0.1:${String(options.port)}`;

  // Use `tsx` from the worktree's node_modules to run the TS source
  // without a compile step. Matches what the user runs by hand.
  const tsx = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    ".bin",
    "tsx",
  );
  const child: ChildProcess = spawn(
    tsx,
    [serverEntryPath()],
    {
      env: {
        ...process.env,
        PORT: String(options.port),
        STORAGE_DIALECT: "pg",
        DATABASE_URL: options.databaseUrl,
        ELECTRIC_URL: options.electricUrl,
        API_KEY_SALT: options.salt,
        // Pre-empt error-handler webhook noise.
        ERROR_WEBHOOK_URL: "",
        // Pre-empt rate-limit interference for tests that do many
        // requests in short windows (creates / drain retries).
        RATE_LIMIT_ENABLED: "false",
      },
      stdio: options.verbose ? "inherit" : "pipe",
      detached: false,
    },
  );

  if (!options.verbose && child.stdout && child.stderr) {
    // Drain to /dev/null so the child doesn't block on a full pipe
    // while still being silent in the test log.
    child.stdout.on("data", () => {
      // intentional drain
    });
    child.stderr.on("data", () => {
      // intentional drain
    });
  }

  const exited = new Promise<{ code: number | null }>((resolveExit) => {
    child.once("exit", (code) => { resolveExit({ code }); });
  });

  try {
    await Promise.race([
      waitForHealth(url, 20_000),
      exited.then(({ code }) => {
        throw new Error(
          `server child exited prematurely with code ${
            code === null ? "null" : String(code)
          }`,
        );
      }),
    ]);
  } catch (error) {
    if (!child.killed) child.kill("SIGTERM");
    throw error;
  }

  return {
    url,
    pid: child.pid ?? -1,
    stop: async () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGTERM");
      // Give it 3s to shut down cleanly; SIGKILL otherwise.
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3_000);
      try {
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    },
  };
}

/**
 * Allocate an ephemeral port. We let the OS pick by binding to 0,
 * grabbing the assigned port, and immediately releasing it; the kernel
 * keeps the port in TIME_WAIT briefly but our subsequent server.listen
 * is reliable in practice. If a future flake traces here, escalate to
 * a port-pool with retry.
 */
export async function pickEphemeralPort(): Promise<number> {
  return await new Promise((resolveOk, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close();
      if (typeof addr === "object" && addr && "port" in addr) {
        resolveOk(addr.port);
      } else {
        reject(new Error("failed to allocate ephemeral port"));
      }
    });
  });
}
