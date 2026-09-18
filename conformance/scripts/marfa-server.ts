/**
 * Boot the server in this repository on SQLite for the suite, mint its first
 * key, and write the env file the run sources.
 *
 *   tsx scripts/marfa-server.ts up [--state <dir>] [--port <n>]
 *   tsx scripts/marfa-server.ts down [--state <dir>]
 *   tsx scripts/marfa-server.ts status [--state <dir>]
 *
 * The state directory holds the SQLite file, the blob folder, the server log,
 * the pid and the env file. It defaults to `.marfa-state` in the working
 * directory and is never removed by this script.
 *
 * The server starts through `tsx` directly rather than the package's `dev`
 * script, which is watch mode and belongs to a person at a keyboard.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseCredentials,
  parseEnvFile,
  readBootstrapSecret,
  renderEnvFile,
} from "../src/utils/target.js";

const HEALTH_BUDGET_MS = 180_000;
const HEALTH_POLL_MS = 250;
const SHUTDOWN_BUDGET_MS = 20_000;

/**
 * The server this boots is the one in the checkout this file is in, found
 * from the file rather than from the working directory so that a run started
 * from anywhere boots the tree it was started from.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Args {
  command: "up" | "down" | "status";
  state: string;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "up" && command !== "down" && command !== "status") {
    throw new Error(
      "usage: marfa-server.ts up [--state <dir>] [--port <n>] | down [--state <dir>] | status [--state <dir>]",
    );
  }
  const args: Args = { command, state: resolve(".marfa-state") };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--state") {
      args.state = resolve(rest[++i] ?? "");
    } else if (arg === "--port") {
      args.port = Number(rest[++i]);
      if (!Number.isInteger(args.port) || args.port <= 0) {
        throw new Error("--port needs a positive integer");
      }
    } else {
      throw new Error(`unexpected argument: ${arg ?? ""}`);
    }
  }
  return args;
}

function paths(state: string) {
  return {
    log: resolve(state, "server.log"),
    pid: resolve(state, "server.pid"),
    db: resolve(state, "marfa.db"),
    blobs: resolve(state, "blobs"),
    env: resolve(state, "env"),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function ensureBuilt(): void {
  if (existsSync(resolve(REPO_ROOT, "packages/shared/dist/index.js"))) return;
  console.log(
    "[marfa-server] workspace packages are not built; running pnpm build",
  );
  const build = spawnSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error("pnpm build failed");
  }
}

function tsxBinary(): string {
  const candidates = [
    resolve(REPO_ROOT, "packages/server/node_modules/.bin/tsx"),
    resolve(REPO_ROOT, "node_modules/.bin/tsx"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error("no tsx binary in this checkout; run pnpm install first");
  }
  return found;
}

function readPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, log: string): Promise<void> {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  const tail = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").slice(-40).join("\n")
    : "(no log written)";
  throw new Error(
    `server did not answer ${url}/health within ${String(HEALTH_BUDGET_MS)}ms. Log tail:\n${tail}`,
  );
}

async function mint(url: string, secret: string) {
  const response = await fetch(`${url}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "operator", source: "operator" }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `bootstrap mint answered ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
  return body as Parameters<typeof chooseCredentials>[0];
}

async function up(args: Args): Promise<void> {
  const p = paths(args.state);
  const existing = readPid(p.pid);
  if (existing !== undefined && alive(existing)) {
    throw new Error(
      `a server is already running from ${args.state} (pid ${String(existing)}); run down first`,
    );
  }
  mkdirSync(p.blobs, { recursive: true });
  ensureBuilt();

  const port = args.port ?? (await freePort());
  const url = `http://127.0.0.1:${String(port)}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    MARFA_AUTH_SECRET:
      process.env.MARFA_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    SQLITE_PATH: p.db,
    BLOB_PATH: p.blobs,
    // Enrichment rewrites file items in the background, which would make
    // exact-property assertions on blobs depend on timing.
    MARFA_ENRICHMENT_ENABLED: "false",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
    // The suite mints and revokes a key per file through /keys, whose fixed
    // limit of 200 requests a minute per credential a local run exceeds.
    RATE_LIMIT_ENABLED: "false",
  };
  delete env.NODE_ENV;

  // The log is appended to, so a boot against a state directory that was
  // already bootstrapped would otherwise re-read the first boot's secret and
  // spend a mint the server has already consumed.
  const logOffset = existsSync(p.log) ? statSync(p.log).size : 0;
  const logFd = openSync(p.log, "a");
  const child = spawn(
    tsxBinary(),
    ["--import", "./src/instrumentation.ts", "src/index.ts"],
    {
      cwd: resolve(REPO_ROOT, "packages/server"),
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  if (child.pid === undefined) {
    throw new Error("failed to spawn the server");
  }
  writeFileSync(p.pid, `${String(child.pid)}\n`);
  child.unref();
  console.log(
    `[marfa-server] started pid ${String(child.pid)} on ${url}; log at ${p.log}`,
  );

  await waitForHealth(url, p.log);

  const secret = readBootstrapSecret(
    readFileSync(p.log).subarray(logOffset).toString("utf8"),
  );
  if (secret === undefined) {
    if (!existsSync(p.env)) {
      throw new Error(
        `the server printed no bootstrap secret and ${p.env} does not exist; the state directory holds a database whose first key this script did not mint`,
      );
    }
    const previous = parseEnvFile(readFileSync(p.env, "utf8"));
    writeFileSync(
      p.env,
      renderEnvFile(url, {
        apiKey: previous.MARFA_API_KEY ?? "",
        operatorKey: previous.MARFA_OPERATOR_KEY ?? "",
      }),
    );
    console.log(`[marfa-server] already bootstrapped; env file at ${p.env}`);
    return;
  }

  const response = await mint(url, secret);
  const credentials = chooseCredentials(response);
  writeFileSync(p.env, renderEnvFile(url, credentials));
  console.log(`[marfa-server] minted the first key; env file at ${p.env}`);
}

async function down(args: Args): Promise<void> {
  const p = paths(args.state);
  const pid = readPid(p.pid);
  if (pid === undefined) {
    console.log(`[marfa-server] no pid file at ${p.pid}; nothing to stop`);
    return;
  }
  if (!alive(pid)) {
    console.log(`[marfa-server] pid ${String(pid)} is not running`);
    rmSync(p.pid, { force: true });
    return;
  }
  // The server was spawned detached, so its pid is also its process group.
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(pid)) {
    console.log(
      `[marfa-server] pid ${String(pid)} ignored SIGTERM; sending SIGKILL`,
    );
    process.kill(-pid, "SIGKILL");
  }
  rmSync(p.pid, { force: true });
  console.log(`[marfa-server] stopped pid ${String(pid)}`);
}

function status(args: Args): void {
  const p = paths(args.state);
  const pid = readPid(p.pid);
  const running = pid !== undefined && alive(pid);
  console.log(
    `[marfa-server] ${running ? `running (pid ${String(pid)})` : "not running"}; state at ${args.state}`,
  );
  if (existsSync(p.env)) {
    const env = parseEnvFile(readFileSync(p.env, "utf8"));
    console.log(`[marfa-server] MARFA_API_URL=${env.MARFA_API_URL ?? ""}`);
  }
  process.exitCode = running ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "up") await up(args);
else if (args.command === "down") await down(args);
else status(args);
