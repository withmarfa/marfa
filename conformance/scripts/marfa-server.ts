import { controlRequest } from "../src/utils/control-request.js";
import { mkdtempSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
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
 *   tsx scripts/marfa-server.ts refused [--state <dir>]
 *
 * `refused` boots the same server on a state directory and waits for it to end
 * instead of for `/health`: for a boot that is meant to be refused.
 *
 * The state directory holds the SQLite file, the blob folder, the server log,
 * the pid, the exit record and the env file. It defaults to `.marfa-state` in
 * the working directory. `down` stops the server and then removes them, so the
 * next `up` is a fresh instance: a database that outlives the bucket it was
 * pointed at registers a second object store on the next boot. The directory
 * itself stays, because `garage/` sits inside it and is the garage script's.
 *
 * `stopServer` stops and nothing more, because the restore drill reads the
 * database of a server it has just stopped.
 *
 * The server starts through `tsx` directly rather than the package's `dev`
 * script, which is watch mode and belongs to a person at a keyboard, under
 * `run-server.mjs`, which writes how the server ended to `server.exit`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  lstatSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  maskInActions,
  parseEnvFile,
  redactSetupProof,
  TEST_OWNER,
  renderEnvFile,
} from "../src/utils/target.js";
import { FRESH_SERVER_LOGS } from "../src/utils/fresh-server.js";

const HEALTH_BUDGET_MS = 180_000;
const HEALTH_POLL_MS = 250;
const SHUTDOWN_BUDGET_MS = 20_000;
/** How long a boot meant to be refused may take to end. */
const REFUSAL_BUDGET_MS = 60_000;

const RUN_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "run-server.mjs",
);

/**
 * The server this boots is the one in the checkout this file is in, found
 * from the file rather than from the working directory so that a run started
 * from anywhere boots the tree it was started from.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Args {
  command: "up" | "down" | "status" | "refused";
  state: string;
  port?: number;
  nodeEnv?: string;
}

/** What a boot needs: the state directory, and a port when one is wanted. */
export interface BootOptions {
  state: string;
  port?: number;
  /**
   * The `NODE_ENV` the server starts under, for a boot meant to be refused
   * over a rule that holds only in one. Left out, the server starts as it
   * does on the run's own, with none set. Named, the script also leaves the
   * two settings production requires, the auth secret and the public URL,
   * to the environment, so the boot reads what the fixture says and not a
   * stand-in.
   */
  nodeEnv?: string;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (
    command !== "up" &&
    command !== "down" &&
    command !== "status" &&
    command !== "refused"
  ) {
    throw new Error(
      "usage: marfa-server.ts up [--state <dir>] [--port <n>] | down [--state <dir>] | status [--state <dir>] | refused [--state <dir>]",
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
    } else if (arg === "--node-env") {
      args.nodeEnv = rest[++i] ?? "";
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
    exit: resolve(state, "server.exit"),
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

/** The tail of the server's log, with the one-time secret taken out. */
function logTail(log: string): string {
  return existsSync(log)
    ? redactSetupProof(
        readFileSync(log, "utf8").split("\n").slice(-40).join("\n"),
      )
    : "(no log written)";
}

/** How the server ended, as the supervisor recorded it. */
function describeExit(exitFile: string): string {
  return existsSync(exitFile)
    ? readFileSync(exitFile, "utf8")
    : "(no exit record)";
}

/**
 * Waits for `/health` to answer, and gives up the moment the server ends,
 * so a boot that was refused is reported as that and not after the budget.
 */
async function waitForHealth(
  url: string,
  p: ReturnType<typeof paths>,
  ended: () => boolean,
): Promise<void> {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    if (ended()) {
      throw new Error(
        `the server ended before it answered ${url}/health: ${describeExit(p.exit)}. Log tail:\n${logTail(p.log)}`,
      );
    }
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
  throw new Error(
    `server did not answer ${url}/health within ${String(HEALTH_BUDGET_MS)}ms. Log tail:\n${logTail(p.log)}`,
  );
}

/** A server started and not yet known to be up. */
interface Started {
  child: ChildProcess;
  url: string;
  /** Where in the log this boot begins. */
  /** Whether the supervisor has ended, which it does when the server does. */
  ended: () => boolean;
  controlSocket: string;
}

async function startServer(args: BootOptions): Promise<Started> {
  const p = paths(args.state);
  const existing = readPid(p.pid);
  if (existing !== undefined && alive(existing)) {
    throw new Error(
      `a server is already running from ${args.state} (pid ${String(existing)}); run down first`,
    );
  }
  cleanupControlDirectory(args.state);
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
  const controlDir = realpathSync(
    mkdtempSync(resolve(tmpdir(), "marfa-control-")),
  );
  chmodSync(controlDir, 0o700);
  const controlSocket = resolve(controlDir, "control.sock");
  writeFileSync(resolve(args.state, "control-directory"), controlDir, {
    mode: 0o600,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    MARFA_CONTROL_SOCKET: controlSocket,
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
  if (args.nodeEnv === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = args.nodeEnv;
    for (const name of ["MARFA_AUTH_SECRET", "MARFA_AUTH_BASE_URL"] as const) {
      if (process.env[name] === undefined) delete env[name];
      else env[name] = process.env[name];
    }
  }

  rmSync(p.exit, { force: true });
  const logFd = openSync(p.log, "a");
  // The supervisor leads the group and the server joins it, so the group's
  // id is still the pid file's and a signal to the group still reaches the
  // server; what the supervisor adds is the server's exit status.
  const child = spawn(
    process.execPath,
    [
      RUN_SERVER,
      p.exit,
      tsxBinary(),
      "--import",
      "./src/instrumentation.ts",
      "src/index.ts",
    ],
    {
      cwd: resolve(REPO_ROOT, "packages/server"),
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  closeSync(logFd);
  if (child.pid === undefined) {
    cleanupControlDirectory(args.state);
    throw new Error("failed to spawn the server");
  }
  let ended = false;
  child.once("exit", () => {
    ended = true;
  });
  writeFileSync(p.pid, `${String(child.pid)}\n`);
  child.unref();
  console.log(
    `[marfa-server] started pid ${String(child.pid)} on ${url}; log at ${p.log}`,
  );
  return { child, url, ended: () => ended, controlSocket };
}

/** Starts the real server without claiming it, for claim-operation tests. */
export async function bootUnclaimedServer(
  args: BootOptions,
): Promise<{ url: string; controlSocket: string }> {
  const started = await startServer(args);
  await waitForHealth(started.url, paths(args.state), started.ended);
  return { url: started.url, controlSocket: started.controlSocket };
}

export async function bootServer(args: BootOptions): Promise<void> {
  const p = paths(args.state);
  const { url, ended, controlSocket } = await startServer(args);
  await waitForHealth(url, p, ended);
  const status = await controlRequest(controlSocket, "/_control/setup/status");
  if (status.status !== 200)
    throw new Error(`Claim status answered ${status.status}`);
  const previous = existsSync(p.env)
    ? parseEnvFile(readFileSync(p.env, "utf8"))
    : {};
  let apiKey: string, managementKey: string;
  if (status.body.claimed === true) {
    apiKey = previous.MARFA_API_KEY ?? "";
    managementKey = previous.MARFA_MANAGEMENT_KEY ?? "";
    if (!apiKey || !managementKey)
      throw new Error(
        "Claimed state has no retained ordinary credentials; use a fresh fixture directory",
      );
  } else {
    const claimed = await controlRequest(
      controlSocket,
      "/_control/setup/claim",
      { method: "POST", body: TEST_OWNER },
    );
    if (claimed.status !== 201)
      throw new Error(`Production owner claim answered ${claimed.status}`);
    const working = await controlRequest(controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "conformance",
        source: "conformance",
        permissions: [
          "schema.write",
          "grants.manage",
          "items.purge",
          "keys.mint",
          "config.manage",
          "audit.read",
          "webhooks.manage",
        ],
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        metadata_permissions: { "*": "write" },
        profile_permissions: { "*": "write" },
      },
    });
    const management = await controlRequest(controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "management",
        source: "management",
        permissions: [
          "schema.write",
          "grants.manage",
          "items.purge",
          "keys.mint",
          "config.manage",
          "audit.read",
          "webhooks.manage",
          "instance.read",
          "instance.maintain",
          "connectors.manage",
          "blobs.manage",
          "keys.manage",
        ],
      },
    });
    if (
      working.status !== 201 ||
      management.status !== 201 ||
      typeof working.body.key !== "string" ||
      typeof management.body.key !== "string"
    )
      throw new Error("Authorised fixture key creation failed");
    apiKey = working.body.key;
    managementKey = management.body.key;
  }
  const signIn = await fetch(`${url}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify(TEST_OWNER),
  });
  if (!signIn.ok)
    throw new Error(`Fixture owner sign-in answered ${signIn.status}`);
  const ownerCookie =
    signIn.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("marfa.auth.session_token="))
      ?.split(";")[0] ?? "";
  if (!ownerCookie) throw new Error("Fixture owner sign-in set no cookie");
  maskInActions(apiKey, managementKey, ownerCookie, TEST_OWNER.password);
  writeFileSync(
    p.env,
    renderEnvFile(
      url,
      { apiKey, managementKey, controlSocket, ownerCookie },
      p.blobs,
      p.statusLogs,
    ),
    { mode: 0o600 },
  );
  console.log(`[marfa-server] claimed and provisioned; env file at ${p.env}`);
}

/**
 * Starts the server on a state directory it is meant to refuse and waits for
 * it to end. No credential is minted and `/health` is never asked: the
 * server's exit record and log are the answer, and are read from the state
 * directory afterwards. A server that is still up when the budget ends is
 * stopped and reported, since a refusal that never came is a failure of the
 * fixture's premise.
 */
export async function bootRefused(args: BootOptions): Promise<void> {
  const p = paths(args.state);
  const { child, ended } = await startServer(args);
  const deadline = Date.now() + REFUSAL_BUDGET_MS;
  while (!ended() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  if (!ended()) {
    await stopServer(args);
    throw new Error(
      `the server did not end within ${String(REFUSAL_BUDGET_MS)}ms, so the boot was not refused. Log tail:\n${logTail(p.log)}`,
    );
  }
  child.unref();
  console.log(
    `[marfa-server] the server ended: ${describeExit(p.exit)}; log at ${p.log}`,
  );
}

function cleanupControlDirectory(state: string): void {
  const marker = resolve(state, "control-directory");
  if (!existsSync(marker)) return;
  const directory = readFileSync(marker, "utf8");
  const root = realpathSync(tmpdir());
  if (
    dirname(directory) !== root ||
    !/^marfa-control-[A-Za-z0-9]+$/.test(basename(directory))
  )
    throw new Error("Fixture control directory marker is unsafe");
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Fixture control directory ownership is unsafe");
    rmSync(directory, { recursive: true });
  }
  rmSync(marker);
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
    cleanupControlDirectory(args.state);
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
  cleanupControlDirectory(args.state);
  console.log(`[marfa-server] stopped pid ${String(pid)}`);
}

/**
 * Removes what one instance left behind: the database, the disk store, the
 * env file, the log and the exit record.
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
    p.exit,
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
  else if (args.command === "refused") await bootRefused(args);
  else if (args.command === "down") {
    await stopServer(args);
    await refuseToClearUnderALiveServer(args.state);
    clearState(args.state);
  } else status(args);
}
