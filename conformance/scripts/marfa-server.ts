/**
 * Boot the server in this repository on SQLite for the suite, mint its first
 * key, and write the env file the run sources. The restore drill imports
 * `bootServer` and `stopServer` to boot the same way, twice.
 *
 *   tsx scripts/marfa-server.ts up [--state <dir>] [--port <n>]
 *
 * The port is `--port`, else `PORT`, else one the kernel says is free. The
 * default is what matters: two boots on one machine, from two worktrees or
 * two agents, never collide.
 *   tsx scripts/marfa-server.ts down [--state <dir>]
 *   tsx scripts/marfa-server.ts status [--state <dir>]
 *
 * The state directory holds the SQLite file, the blob folder, the server log,
 * the pid and the env file. It defaults to `.marfa-state` in the working
 * directory. `down` stops the server and then removes those five, so the
 * next `up` is a fresh instance: a database that outlives the bucket it was
 * pointed at registers a second object store on the next boot. The directory
 * itself stays, because `garage/` sits inside it and is the garage script's.
 *
 * `stopServer` stops and nothing more, because the restore drill reads the
 * database of a server it has just stopped.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chooseCredentials,
  maskInActions,
  parseEnvFile,
  readBootstrapSecret,
  redactBootstrapSecret,
  renderEnvFile,
} from "../src/utils/target.js";
import { FRESH_SERVER_LOGS } from "../src/utils/fresh-server.js";

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

/** What a boot needs: the state directory, and a port when one is wanted. */
export interface BootOptions {
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
    statusLogs: resolve(state, FRESH_SERVER_LOGS),
  };
}

/** `PORT` from the environment, when it names one. */
function envPort(): number | undefined {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `PORT is set to ${raw}, which is not a port; unset it or give a number`,
    );
  }
  return port;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    // No host, so the probe binds as the server does, on both families.
    probe.listen(0, () => {
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
    ? redactBootstrapSecret(
        readFileSync(log, "utf8").split("\n").slice(-40).join("\n"),
      )
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

export async function bootServer(args: BootOptions): Promise<void> {
  const p = paths(args.state);
  const existing = readPid(p.pid);
  if (existing !== undefined && alive(existing)) {
    throw new Error(
      `a server is already running from ${args.state} (pid ${String(existing)}); run down first`,
    );
  }
  mkdirSync(p.blobs, { recursive: true });
  // The folder holds the server's keys, and `--state` takes any name, so
  // it ignores itself rather than relying on the root `.gitignore` knowing
  // the name.
  writeFileSync(resolve(args.state, ".gitignore"), "*\n");
  ensureBuilt();

  // `--port`, then `PORT`, then one the kernel says is free.
  //
  // `PORT` is read as well as written because the sibling boot path,
  // `core/scripts/server-up.sh`, takes its port that way, and an instruction
  // that works on one and silently does nothing on the other is worse than
  // having no lever at all: a caller who exported it would believe they were
  // pinned while nothing had changed. Both default to a free port, so nobody
  // needs either lever to avoid a collision.
  const port = args.port ?? envPort() ?? (await freePort());
  const url = `http://127.0.0.1:${String(port)}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    MARFA_AUTH_SECRET:
      process.env.MARFA_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    SQLITE_PATH: p.db,
    BLOB_PATH: p.blobs,
    // The origin the server is reached at, which a link it mints carries.
    MARFA_AUTH_BASE_URL: url,
    // Enrichment rewrites file items in the background, which would make
    // exact-property assertions on blobs depend on timing. Off unless the
    // caller says otherwise, as the limiter below is, so a fixture about
    // enrichment can boot a server of its own with it on.
    MARFA_ENRICHMENT_ENABLED: process.env.MARFA_ENRICHMENT_ENABLED || "false",
    MARFA_ENRICHMENT_OCR_ENABLED:
      process.env.MARFA_ENRICHMENT_OCR_ENABLED || "false",
    // The orphan sweep purges what an earlier run reported once this much
    // time has passed: zero, so a fixture can drive the report and the
    // purge as two runs through the housekeeping door. The sweep's own
    // cadence stays a day, but its first run is thirty seconds after boot
    // and a run is a run — so a fixture that reads the report has to expect
    // one of its own rows to have been purged by the scheduler and ask
    // again. Replication's cadence is an hour, so between an upload's own
    // wake and the fixture's runs nothing copies on a clock of its own.
    // Overridable, as the limiter is below: a fixture about a positive grace
    // boots a server of its own with one, and `marfa:up` pins zero outright.
    MARFA_BLOB_CLEANUP_GRACE_MS: process.env.MARFA_BLOB_CLEANUP_GRACE_MS || "0",
    MARFA_BLOB_REPLICATE_INTERVAL_MS: "3600000",
    // Off unless the caller says otherwise. A fixture about the limiter
    // boots a server of its own with it on, and this literal sits after
    // the spread — pinned, it would overwrite what such a fixture asked
    // for and leave both halves of the case passing against a server
    // with no limiter at all. The run's own server does not rely on the
    // default here: `marfa:up` says `false` outright, so an ambient
    // variable cannot flip the instance every other file shares.
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED || "false",
    // Every webhook fixture delivers to a receiver on loopback, which a
    // server refuses by default. On unless the caller says otherwise, so the
    // fixture about that refusal can boot a server of its own with it off.
    MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES:
      process.env.MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES || "true",
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
    maskInActions(
      previous.MARFA_API_KEY ?? "",
      previous.MARFA_OPERATOR_KEY ?? "",
    );
    writeFileSync(
      p.env,
      renderEnvFile(
        url,
        {
          apiKey: previous.MARFA_API_KEY ?? "",
          operatorKey: previous.MARFA_OPERATOR_KEY ?? "",
        },
        p.blobs,
        p.statusLogs,
      ),
    );
    console.log(`[marfa-server] already bootstrapped; env file at ${p.env}`);
    return;
  }

  const response = await mint(url, secret);
  const credentials = chooseCredentials(response);
  maskInActions(credentials.apiKey, credentials.operatorKey);
  writeFileSync(p.env, renderEnvFile(url, credentials, p.blobs, p.statusLogs));
  console.log(`[marfa-server] minted the first key; env file at ${p.env}`);
}

export async function stopServer(args: BootOptions): Promise<void> {
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
  // A group that is gone between the liveness check and the signal is the
  // outcome wanted, not a failure to stop.
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(pid)) {
    console.log(
      `[marfa-server] pid ${String(pid)} ignored SIGTERM; sending SIGKILL`,
    );
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  rmSync(p.pid, { force: true });
  console.log(`[marfa-server] stopped pid ${String(pid)}`);
}

/**
 * Removes what one instance left behind: the database, the disk store, the
 * env file and the log.
 *
 * **A stopped server's database outliving its bucket is a second store.**
 * A store's id comes from a marker the store itself holds rather than from
 * the configuration that named it (the prose after `spec/stores.md`'s first
 * four statements says so, and why it is not a statement), so the bucket
 * `garage:up` makes after a `garage:down` carries
 * no marker and the boot against a database that still holds the old
 * store's row mints a second id beside it. The old row is detached rather
 * than removed and its location rows stay, so a deterministic blob
 * re-uploaded into the new bucket reads as three copies where the chapter
 * says two.
 *
 * Scoped to the four paths this script writes rather than to the directory,
 * because `garage/` sits inside it and belongs to a node that may still be
 * running. SQLite's sidecars go with the database: a `-wal` left beside a
 * removed file is replayed into the next one.
 */
function clearState(state: string): void {
  const p = paths(state);
  for (const path of [
    p.db,
    `${p.db}-wal`,
    `${p.db}-shm`,
    p.env,
    p.log,
    p.blobs,
    p.statusLogs,
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  console.log(`[marfa-server] cleared the state under ${state}`);
}

/**
 * `stopServer` stops the process the pid file names and stops there: with
 * no pid file, or a pid that is not running, it has nothing to signal. A
 * server can still be answering on the URL the env file recorded (its pid
 * file removed by hand, or the state directory shared with a boot this
 * script did not make), and unlinking the database and the disk store
 * under a live server is the one thing `down` must never do. So the URL is
 * asked before anything is removed.
 */
async function refuseToClearUnderALiveServer(state: string): Promise<void> {
  const p = paths(state);
  if (!existsSync(p.env)) return;
  const url = parseEnvFile(readFileSync(p.env, "utf8")).MARFA_API_URL;
  if (!url) return;
  let answered = false;
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    answered = response.ok;
  } catch {
    answered = false;
  }
  if (answered) {
    throw new Error(
      `${url} still answers /health and ${p.pid} does not name it, so the state under ${state} is not cleared. Stop that server first.`,
    );
  }
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

// The command runs only when this file is the program, so the drill can
// import the two functions without booting anything.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "up") await bootServer(args);
  else if (args.command === "down") {
    await stopServer(args);
    await refuseToClearUnderALiveServer(args.state);
    clearState(args.state);
  } else status(args);
}
