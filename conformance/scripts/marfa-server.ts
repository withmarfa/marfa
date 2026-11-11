import { controlRequest } from "../src/utils/control-request.js";
import { mkdtempSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
/**
 * Boot the server in this repository on SQLite for the suite, mint its first
 * key, and write the env file the run sources. The restore drill imports
 * `bootServer` and `stopServer` to boot the same way, twice.
 *
 *   tsx scripts/marfa-server.ts up [--state <dir>] [--port <n>] [--env K=V ...]
 *
 * The port is `--port`, else `MARFA_PORT`, else zero for the server to bind an
 * assigned port on IPv4 loopback. Readiness comes from this boot's log before
 * any health request is sent. Each `--env K=V` is a setting for the boot
 * (`conformance/README.md` lists the ones a fixture may pass), and wins over
 * the script's own defaults and the caller's environment.
 *   tsx scripts/marfa-server.ts down [--state <dir>]
 *   tsx scripts/marfa-server.ts status [--state <dir>]
 *   tsx scripts/marfa-server.ts refused [--state <dir>] [--env K=V ...]
 *   tsx scripts/marfa-server.ts restart [--state <dir>] [--signal TERM|INT|KILL] [--env K=V ...]
 *   tsx scripts/marfa-server.ts clock [--state <dir>] advance <ms>|pause|resume
 *   tsx scripts/marfa-server.ts fault [--state <dir>] set <name>[=<arg>] | clear [<name>] | list
 *   tsx scripts/marfa-server.ts log [--state <dir>]
 *
 * `refused` boots the same server on a state directory and waits for it to end
 * instead of for `/health`: for a boot that is meant to be refused.
 *
 * `log` prints what the server wrote to its log, then to stderr.
 *
 * `restart` stops the server with the signal (`TERM` by default), prints how
 * it ended as `[marfa-server] previous exit {"code":..,"signal":..,"ms":..}`,
 * and boots it again on the same data. The URL may change and the env file is
 * rewritten.
 *
 * `clock pause` stops real-time drift; `clock resume` catches up again.
 * `clock advance` moves the server's clock forward. The server refuses a
 * negative step. The adapter keeps the offset in the state directory and
 * passes it back on the next boot, so a restarted server does not go back in
 * time. `fault set` arms a named fault, `fault clear` removes one or all, and
 * `fault list` prints `{"faults":[{"name":..,"arg":..,"waiting":..,"fired":..}]}`,
 * with `held_when_answered` on a `release` fault that has acted. A server
 * starts with no fault.
 *
 * The state directory holds the SQLite file, the blob folder, the server log
 * (what the server wrote to stdout, which is JSON lines only), what it wrote
 * to stderr, the pid, the exit record, the clock offset and the env file. It
 * defaults to `.marfa-state` in the working directory. `down` stops the server and then removes them, so the
 * next `up` is a fresh instance: a database that outlives the bucket it was
 * pointed at registers a second object store on the next boot. The directory
 * itself stays, because `garage/` sits inside it and is the garage script's.
 *
 * `stopServer` stops and nothing more, because the restore drill reads the
 * database of a server it has just stopped.
 *
 * The server starts as a direct Node child with the tsx loader and the
 * instrumentation preload, under `run-server.mjs`, which writes how the
 * server ended to `server.exit`. The package's `dev` script is watch mode
 * and belongs to a person at a keyboard.
 *
 * With `MARFA_SERVER_BUILT=true` it starts the built server instead
 * (`packages/server/dist/index.js` with `dist/instrumentation.js`), which is
 * what a person runs, for a run that measures memory or start-up time. The
 * environment variable, not an option, so that a `restart` follows the boot
 * it replaces. A built server is started with `MARFA_TEST_HOOKS` off: the
 * clock shim and the fault routes exist only in the source run, and the built
 * run is without them, as a person's is. Nothing that reads the clock or the
 * fault table can run against it. The build must be there already
 * (`pnpm --filter "@withmarfa/server..." build`); it is not made here.
 *
 * With `MARFA_SERVER_BIN=<program>` it starts that program instead, a server
 * of another implementation, with the same settings, supervisor, state
 * directory and log, and with the state directory as its working directory.
 * Nothing in the workspace is built for it. It must carry its test hooks (a
 * Rust server built with `--features test-hooks`), which the settings below
 * switch on. The claim and the keys go through
 * the private socket as for this server. A target whose sign-in door answers
 * `404 not_found` has no owner sign-in, and the env file then carries no
 * owner cookie or session file. `clock` and `fault` fail plainly against a
 * target without the hooks.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  lstatSync,
  closeSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  maskInActions,
  parseEnvFile,
  redactSetupProof,
  TEST_OWNER,
  renderEnvFile,
} from "../src/utils/target.js";
import { authenticateOwner } from "../src/client/owner-session.js";
import { silenceTelemetry } from "../../vitest.shared.js";
import { FRESH_SERVER_LOGS } from "../src/utils/fresh-server.js";
import {
  groupOf,
  signalGroup,
  STOP_SIGNALS,
  stopWithSignal,
  type StopSignal,
} from "../src/utils/server-process.js";

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

/**
 * The settings the TypeScript server reads under other names, by the name the
 * contract gives them. This is the only place the old names appear.
 */
const TYPESCRIPT_SETTING_NAMES: ReadonlyMap<string, string> = new Map([
  ["MARFA_PORT", "PORT"],
  ["MARFA_DATABASE_PATH", "SQLITE_PATH"],
  ["MARFA_BLOB_PATH", "BLOB_PATH"],
  ["MARFA_KEY_SALT", "API_KEY_SALT"],
  ["MARFA_TRUSTED_PROXY_CIDRS", "TRUSTED_PROXY_CIDRS"],
  ["MARFA_TRUSTED_PROXY_HEADER", "TRUSTED_PROXY_HEADER"],
  ["MARFA_ERROR_WEBHOOK_URL", "ERROR_WEBHOOK_URL"],
  ["MARFA_WRITE_WAIT_MS", "SQLITE_BUSY_BUDGET_MS"],
  ["MARFA_SIGN_IN_ADDRESS", "MARFA_AUTH_BASE_URL"],
  ...[
    "RATE_LIMIT_ENABLED",
    "RATE_LIMIT_KEYS_REQUESTS",
    "RATE_LIMIT_WINDOW_MS",
    "RATE_LIMIT_REQUESTS",
    "RATE_LIMIT_AGGREGATE_MULTIPLIER",
    "RATE_LIMIT_INBOUND_REQUESTS",
    "AUDIT_RETENTION_DAYS",
    "TRASH_RETENTION_DAYS",
    "VERSION_RECENT_DAYS",
    "VERSION_DAILY_SNAPSHOT_DAYS",
    "VERSION_WEEKLY_SNAPSHOT_DAYS",
    "VERSION_MAX_VERSIONS",
    "AUDIT_CLEANUP_INTERVAL_MS",
    "AUTH_SESSION_CLEANUP_INTERVAL_MS",
    "FEED_EXPIRY_INTERVAL_MS",
    "TRASH_PURGE_INTERVAL_MS",
    "VERSION_THINNING_INTERVAL_MS",
    "CORS_ORIGINS",
    "ENABLE_HSTS",
  ].map((name): [string, string] => [`MARFA_${name}`, name]),
]);

/** The timings `MARFA_TEST_TUNING` names, by the setting the TypeScript server reads each as. */
const TUNING_NAMES: ReadonlyMap<string, string> = new Map([
  ["housekeeping_poll_ms", "MARFA_HOUSEKEEPING_POLL_INTERVAL_MS"],
  ["write_wait_ms", "MARFA_WRITE_WAIT_MS"],
  ["upload_idle_ms", "MARFA_UPLOAD_IDLE_TIMEOUT_MS"],
  ["blob_read_idle_ms", "MARFA_BLOB_READ_IDLE_TIMEOUT_MS"],
  ["inbound_read_ms", "MARFA_INBOUND_READ_TIMEOUT_MS"],
  ["connector_hold_ms", "MARFA_CONNECTOR_HOLD_MS"],
  ["enrichment_batch", "MARFA_ENRICHMENT_BATCH_SIZE"],
  ["blob_replicate_batch", "MARFA_BLOB_REPLICATE_BATCH"],
  ["blob_replicate_batch_bytes", "MARFA_BLOB_REPLICATE_BATCH_BYTES"],
  ["blob_integrity_batch", "MARFA_BLOB_INTEGRITY_BATCH"],
  ["blob_integrity_batch_bytes", "MARFA_BLOB_INTEGRITY_BATCH_BYTES"],
]);

/** The jobs whose interval the TypeScript server takes as a setting, by that setting. */
const JOB_INTERVAL_NAMES: ReadonlyMap<string, string> = new Map([
  ["heartbeat", "MARFA_HEARTBEAT_INTERVAL_MS"],
  ["enrichment-sweep", "MARFA_ENRICHMENT_INTERVAL_MS"],
  ["audit-cleanup", "MARFA_AUDIT_CLEANUP_INTERVAL_MS"],
  ["trash-purge", "MARFA_TRASH_PURGE_INTERVAL_MS"],
  ["version-thinning", "MARFA_VERSION_THINNING_INTERVAL_MS"],
  ["feed-expiry", "MARFA_FEED_EXPIRY_INTERVAL_MS"],
  ["event-log-cleanup", "MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS"],
  ["inbound-delivery-cleanup", "MARFA_INBOUND_CLEANUP_INTERVAL_MS"],
  ["credential-cleanup", "MARFA_CREDENTIAL_CLEANUP_INTERVAL_MS"],
  ["blob-replicate", "MARFA_BLOB_REPLICATE_INTERVAL_MS"],
  ["blob-orphans", "MARFA_BLOB_CLEANUP_INTERVAL_MS"],
  ["blob-integrity", "MARFA_BLOB_INTEGRITY_INTERVAL_MS"],
]);

/** Settings the contract gives in seconds that the TypeScript server reads in milliseconds. */
const SECONDS_AS_MILLISECONDS: ReadonlyMap<string, string> = new Map([
  ["MARFA_BACKUP_INTERVAL_SECONDS", "MARFA_BACKUP_INTERVAL_MS"],
  ["MARFA_BLOB_CLEANUP_GRACE_SECONDS", "MARFA_BLOB_CLEANUP_GRACE_MS"],
  ["MARFA_RATE_LIMIT_WINDOW_SECONDS", "MARFA_RATE_LIMIT_WINDOW_MS"],
  ["MARFA_MCP_FETCH_TIMEOUT_SECONDS", "MARFA_MCP_FETCH_TIMEOUT_MS"],
]);

/** The settings the TypeScript server has under another shape than the contract's. */
function reshapedForTypeScript(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const tuned = new Map<string, string>();
  const everyJob = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    const seconds = SECONDS_AS_MILLISECONDS.get(name);
    if (name === "MARFA_TEST_TUNING" && value !== undefined) {
      for (const pair of value.split(",").filter((text) => text.trim())) {
        const [key = "", given = ""] = pair.trim().split("=");
        if (key.startsWith("interval.")) {
          const job = key.slice("interval.".length);
          if (job === "*") {
            for (const setting of JOB_INTERVAL_NAMES.values()) {
              everyJob.set(setting, given);
            }
          } else {
            const setting = JOB_INTERVAL_NAMES.get(job);
            if (setting !== undefined) tuned.set(setting, given);
          }
        } else {
          const setting = TUNING_NAMES.get(key);
          if (setting !== undefined) tuned.set(setting, given);
        }
      }
    } else if (seconds !== undefined) {
      out[seconds] = value === undefined ? value : String(Number(value) * 1000);
    } else if (name === "MARFA_BLOB_CLEANUP_ENABLED") {
      if (value !== undefined && /^(false|0|no|off)$/i.test(value)) {
        out.MARFA_BLOB_CLEANUP_INTERVAL_MS = "0";
      }
    } else {
      out[name] = value;
    }
  }
  for (const [name, value] of everyJob) out[name] ??= value;
  for (const [name, value] of tuned) out[name] = value;
  return out;
}

/** The environment with each setting under the name the TypeScript server reads. */
export function typeScriptSettingNames(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = reshapedForTypeScript(environment);
  const out: NodeJS.ProcessEnv = {};
  const renamed: [string, string | undefined][] = [];
  for (const [name, value] of Object.entries(env)) {
    const own = TYPESCRIPT_SETTING_NAMES.get(name);
    if (own === undefined) out[name] = value;
    else renamed.push([own, value]);
  }
  for (const [name, value] of renamed) out[name] = value;
  return out;
}

/** The contract's name for a setting the TypeScript server names otherwise. */
export function contractSettingName(typeScriptName: string): string {
  for (const [name, own] of TYPESCRIPT_SETTING_NAMES) {
    if (own === typeScriptName) return name;
  }
  return typeScriptName;
}

interface Args {
  command:
    | "up"
    | "down"
    | "status"
    | "refused"
    | "restart"
    | "clock"
    | "fault"
    | "image"
    | "log";
  state: string;
  /** For `image`: the directory the copy is made into. */
  to?: string;
  port?: number;
  env: Record<string, string>;
  signal: StopSignal;
  /** What follows the options: the subcommand of `clock` and `fault`. */
  words: string[];
}

/** What a boot needs: the state directory, and a port when one is wanted. */
export interface BootOptions {
  state: string;
  port?: number;
  controlOnly?: boolean;
  /**
   * Settings for this boot, by name. They win over the script's defaults
   * and over the environment the script was started in.
   */
  env?: Record<string, string>;
}

const COMMANDS = [
  "up",
  "down",
  "status",
  "refused",
  "restart",
  "clock",
  "fault",
  "image",
  "log",
] as const;

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!COMMANDS.some((known) => known === command)) {
    throw new Error(
      "usage: marfa-server.ts up|refused [--state <dir>] [--port <n>] [--env K=V ...] | restart [--state <dir>] [--signal TERM|INT|KILL] [--env K=V ...] | down|status [--state <dir>] | clock [--state <dir>] advance <ms>|pause|resume | fault [--state <dir>] set <name>[=<arg>] | clear [<name>] | list | image [--state <dir>] --to <dir> | log [--state <dir>]",
    );
  }
  const args: Args = {
    command: command as Args["command"],
    state: resolve(".marfa-state"),
    env: {},
    signal: "SIGTERM",
    words: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--state") {
      args.state = resolve(rest[++i] ?? "");
    } else if (arg === "--port") {
      args.port = Number(rest[++i]);
      if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65_535) {
        throw new Error("--port needs an integer from 0 to 65535");
      }
    } else if (arg === "--to" && args.command === "image") {
      args.to = resolve(rest[++i] ?? "");
    } else if (arg === "--env") {
      const pair = rest[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error("--env needs K=V");
      args.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--signal") {
      const name = `SIG${(rest[++i] ?? "").toUpperCase()}`;
      const signal = STOP_SIGNALS.find((known) => known === name);
      if (signal === undefined)
        throw new Error("--signal needs TERM, INT or KILL");
      args.signal = signal;
    } else if (
      (args.command === "clock" || args.command === "fault") &&
      arg !== undefined &&
      !arg.startsWith("--")
    ) {
      args.words.push(arg);
    } else {
      throw new Error(`unexpected argument: ${arg ?? ""}`);
    }
  }
  return args;
}

function paths(state: string) {
  return {
    log: resolve(state, "server.log"),
    stderr: resolve(state, "server.stderr"),
    clock: resolve(state, "clock-offset"),
    pid: resolve(state, "server.pid"),
    exit: resolve(state, "server.exit"),
    db: resolve(state, "marfa.db"),
    blobs: resolve(state, "blobs"),
    env: resolve(state, "env"),
    statusLogs: resolve(state, FRESH_SERVER_LOGS),
  };
}

/** A port named by `MARFA_PORT`, when it names one. */
function namedPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `MARFA_PORT is set to ${raw}, which is not a port; unset it or give a number`,
    );
  }
  return port;
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

let pageAssetsWritten = false;

/**
 * The server imports its page assets from a generated file Git does not
 * track. Written here from the sources, once for the process, so a boot from
 * source never serves a stylesheet or script older than them.
 */
function ensurePageAssets(): void {
  if (pageAssetsWritten) return;
  const build = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/build-page-assets.ts"],
    { cwd: resolve(REPO_ROOT, "packages/server"), stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error("building the page assets failed");
  }
  pageAssetsWritten = true;
}

/** Whether this run starts the built server, not the sources. */
export function builtServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARFA_SERVER_BUILT === "true";
}

/** The program `MARFA_SERVER_BIN` names, when it names one. */
export function serverProgram(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const program = env.MARFA_SERVER_BIN;
  if (program === undefined || program === "") return undefined;
  if (builtServer(env)) {
    throw new Error(
      "MARFA_SERVER_BIN and MARFA_SERVER_BUILT are both set; set one",
    );
  }
  const path = resolve(program);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`MARFA_SERVER_BIN names ${path}, which is not a file`);
  }
  return path;
}

/** The built server's two entry files, which a build writes. */
const BUILT_ENTRY = resolve(REPO_ROOT, "packages/server/dist/index.js");
const BUILT_PRELOAD = resolve(
  REPO_ROOT,
  "packages/server/dist/instrumentation.js",
);

/** What the supervisor starts: the sources through tsx, or the build. */
export function serverCommand(built: boolean): [string, ...string[]] {
  if (!built) {
    return serverRuntime([
      "--import",
      "./src/instrumentation.ts",
      "src/index.ts",
    ]);
  }
  for (const file of [BUILT_ENTRY, BUILT_PRELOAD]) {
    if (!existsSync(file)) {
      throw new Error(
        `MARFA_SERVER_BUILT is true and ${file} is missing; build the server first`,
      );
    }
  }
  return [process.execPath, "--import", BUILT_PRELOAD, BUILT_ENTRY];
}

/** Runtime command supervised for a server entrypoint and its preloads. */
export function serverRuntime(args: string[]): [string, ...string[]] {
  // The tsx CLI force-kills a child that cannot acknowledge a signal within
  // its short relay window. A direct Node child lets shutdown finish and
  // makes the supervisor record the server's own exit.
  return [process.execPath, "--import", "tsx", ...args];
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

/**
 * The tail of the server's output, with the one-time secret taken out: its
 * log (stdout) and, when it wrote any, what it printed to stderr.
 */
function logTail(p: ReturnType<typeof paths>): string {
  const tail = (path: string) =>
    existsSync(path)
      ? redactSetupProof(
          readFileSync(path, "utf8").split("\n").slice(-40).join("\n"),
        )
      : "";
  const out = tail(p.log);
  const err = tail(p.stderr);
  if (out === "" && err === "") return "(no log written)";
  return err === "" ? out : `${out}\n--- stderr ---\n${err}`;
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
  started: Started,
  p: ReturnType<typeof paths>,
): Promise<string> {
  let url: string | undefined;
  let lastFailure = "no readiness record";
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    if (started.ended()) {
      throw new Error(
        `the server ended before readiness: ${describeExit(p.exit)}. Log tail:\n${logTail(p)}`,
      );
    }
    if (!url && existsSync(p.log)) {
      // A restart appends to the log. Only complete records from this boot
      // can identify its listener; an old port may now belong to anyone.
      const lines = readFileSync(p.log)
        .subarray(started.logStart)
        .toString("utf8")
        .split("\n");
      for (const line of lines.slice(0, -1)) {
        let record: { message?: unknown };
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          continue;
        }
        if (typeof record?.message !== "string") continue;
        const match = /^Marfa server listening on port ([0-9]+)$/.exec(
          record.message,
        );
        if (match) {
          const port = Number(match[1]);
          if (port > 0 && port <= 65_535) url = `http://127.0.0.1:${port}`;
        }
      }
    }
    if (url) {
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5_000),
          headers: { Connection: "close" },
        });
        await response.text();
        if (response.ok && !started.ended()) return url;
        lastFailure = `HTTP ${response.status}`;
      } catch (error) {
        lastFailure =
          error instanceof Error
            ? `${error.message}; cause: ${String(error.cause)}`
            : String(error);
      }
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(
    `server did not become ready within ${String(HEALTH_BUDGET_MS)}ms (${url ?? "no listener"}; ${lastFailure}). Log tail:\n${logTail(p)}`,
  );
}

/** A server started and not yet known to be up. */
interface Started {
  child: ChildProcess;
  /** Where in the log this boot begins, in bytes. */
  logStart: number;
  /** Whether the supervisor has ended, which it does when the server does. */
  ended: () => boolean;
  controlSocket: string;
  authSecret: string;
}

/** The offset the last `clock advance` left, in ms; zero when none did. */
function readClockOffset(file: string): number {
  if (!existsSync(file)) return 0;
  const offset = Number(readFileSync(file, "utf8").trim());
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

async function startServer(args: BootOptions): Promise<Started> {
  const program = serverProgram();
  const p = paths(args.state);
  const existing = readPid(p.pid);
  if (existing !== undefined && alive(existing)) {
    throw new Error(
      `a server is already running from ${args.state} (pid ${String(existing)}); run down first`,
    );
  }
  if (
    existing === undefined &&
    existsSync(resolve(args.state, "control-directory"))
  )
    throw new Error(
      "A control directory exists without its process record; verify the server has stopped before removing it",
    );
  cleanupControlDirectory(args.state);
  mkdirSync(p.blobs, { recursive: true });
  // The folder holds the server's keys, and `--state` takes any name, so
  // it ignores itself rather than relying on the root `.gitignore` knowing
  // the name.
  writeFileSync(resolve(args.state, ".gitignore"), "*\n");
  const built = program === undefined && builtServer();
  if (program === undefined) {
    ensureBuilt();
    if (!built) ensurePageAssets();
  }

  const port =
    args.port ??
    namedPort(args.env?.MARFA_PORT) ??
    namedPort(process.env.MARFA_PORT) ??
    0;
  // A caller that names the socket owns its folder and what stands there.
  const named = args.env?.MARFA_CONTROL_SOCKET;
  let controlSocket: string;
  if (named === undefined) {
    const controlDir = realpathSync(
      mkdtempSync(resolve(tmpdir(), "marfa-control-")),
    );
    chmodSync(controlDir, 0o700);
    controlSocket = resolve(controlDir, "control.sock");
    writeFileSync(resolve(args.state, "control-directory"), controlDir, {
      mode: 0o600,
    });
  } else {
    controlSocket = resolve(named);
  }
  const retainedEnv = existsSync(p.env)
    ? parseEnvFile(readFileSync(p.env, "utf8"))
    : {};
  const authSecret =
    process.env.MARFA_AUTH_SECRET ??
    retainedEnv.MARFA_FIXTURE_AUTH_SECRET ??
    randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MARFA_PORT: String(port),
    MARFA_LISTEN_HOST: "127.0.0.1",
    MARFA_CONTROL_SOCKET: controlSocket,
    ...(args.controlOnly !== undefined && {
      MARFA_CONTROL_ONLY: String(args.controlOnly),
    }),
    MARFA_AUTH_SECRET: authSecret,
    MARFA_DATABASE_PATH: p.db,
    MARFA_BLOB_PATH: p.blobs,
    // The sign-in address is the server's own, on its assigned port.
    MARFA_SIGN_IN_ADDRESS: undefined,
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
    // one of its own items to have been purged by the scheduler and ask
    // again. Replication's cadence is an hour, so between an upload's own
    // wake and the fixture's runs nothing copies on a clock of its own.
    // Overridable, as the limiter is below: a fixture about a positive grace
    // boots a server of its own with one, and `marfa:up` pins zero outright.
    MARFA_BLOB_CLEANUP_GRACE_SECONDS:
      process.env.MARFA_BLOB_CLEANUP_GRACE_SECONDS || "0",
    MARFA_TEST_TUNING: "interval.blob-replicate=3600000",
    // Off unless the caller says otherwise. A fixture about the limiter
    // boots a server of its own with it on, and this literal sits after
    // the spread — pinned, it would overwrite what such a fixture asked
    // for and leave both halves of the case passing against a server
    // with no limiter at all. The run's own server does not rely on the
    // default here: `marfa:up` says `false` outright, so an ambient
    // variable cannot flip the instance every other file shares.
    MARFA_RATE_LIMIT_ENABLED: process.env.MARFA_RATE_LIMIT_ENABLED || "false",
    // Every webhook fixture delivers to a receiver on loopback, which a
    // server refuses by default. On unless the caller says otherwise, so the
    // fixture about that refusal can boot a server of its own with it off.
    MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES:
      process.env.MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES || "true",
  };
  // The built TypeScript server is started as a person starts it, without the
  // hooks. Any other target is built with them.
  const hooks = !built;
  env.MARFA_TEST_HOOKS = String(hooks);
  delete env.MARFA_TEST_CLOCK_OFFSET_MS;
  // A throwaway server reports nothing, whatever the shell sets; a setting the
  // caller names below still wins.
  silenceTelemetry(env);
  // What the caller names wins over every default above, but for the tuning,
  // which adds to the defaults, and only where the hooks are on.
  const defaultTuning = env.MARFA_TEST_TUNING;
  Object.assign(env, args.env);
  const hooksOn = /^(true|1|yes|on)$/i.test(env.MARFA_TEST_HOOKS ?? "");
  const tuning = [
    hooksOn ? defaultTuning : undefined,
    args.env?.MARFA_TEST_TUNING,
  ]
    .filter((text) => text)
    .join(",");
  if (tuning === "") delete env.MARFA_TEST_TUNING;
  else env.MARFA_TEST_TUNING = tuning;
  // The command-line port wins over the environment, including --env MARFA_PORT.
  env.MARFA_PORT = String(port);
  // A restart inherits the latest move, never the original boot setting.
  if (hooks && existsSync(p.clock)) {
    env.MARFA_TEST_CLOCK_OFFSET_MS = String(readClockOffset(p.clock));
  }

  rmSync(p.exit, { force: true });
  // Stdout holds the server's JSON log lines and nothing else, which is what
  // `check:statuses` reads. Whatever else the process prints, a Node warning
  // or a trace, goes to its own file.
  const logStart = existsSync(p.log) ? statSync(p.log).size : 0;
  const logFd = openSync(p.log, "a");
  const errFd = openSync(p.stderr, "a");
  // The supervisor leads the group and the server joins it, so the group's
  // id is still the pid file's and a signal to the group still reaches the
  // server; what the supervisor adds is the server's exit status.
  const child = spawn(
    process.execPath,
    [RUN_SERVER, p.exit, ...(program ? [program] : serverCommand(built))],
    {
      cwd: program ? args.state : resolve(REPO_ROOT, "packages/server"),
      env: program ? env : typeScriptSettingNames(env),
      detached: true,
      stdio: ["ignore", logFd, errFd],
    },
  );
  closeSync(logFd);
  closeSync(errFd);
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
    `[marfa-server] started pid ${String(child.pid)} with requested port ${String(port)}; log at ${p.log}`,
  );
  return { child, logStart, ended: () => ended, controlSocket, authSecret };
}

/** Starts the real server without claiming it, for claim-operation tests. */
export async function bootUnclaimedServer(
  args: BootOptions,
): Promise<{ url: string; controlSocket: string }> {
  const started = await startServer(args);
  const url = await waitForHealth(started, paths(args.state));
  return { url, controlSocket: started.controlSocket };
}

/** Starts only the private listener, without provisioning an owner. */
export async function bootControlServer(
  args: BootOptions,
): Promise<{ controlSocket: string }> {
  const started = await startServer({ ...args, controlOnly: true });
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    if (started.ended()) {
      throw new Error(
        `Control-only server ended: ${logTail(paths(args.state))}`,
      );
    }
    try {
      const response = await controlRequest(started.controlSocket, "/health");
      if (response.status === 200)
        return { controlSocket: started.controlSocket };
    } catch {
      // The private listener has not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(
    `Control-only server did not start: ${logTail(paths(args.state))}`,
  );
}

const SIGN_IN_DOOR = "/auth/sign-in/email";

/**
 * The owner's session cookie, or undefined for a target with no owner
 * sign-in. The door is asked again only once the sign-in has failed, so a
 * target that has one spends no extra attempt against its sign-in throttle.
 */
async function signInOwner(
  url: string,
  retained: string | undefined,
): Promise<string | undefined> {
  try {
    return await authenticateOwner(url, retained, TEST_OWNER);
  } catch (error) {
    if (await signInDoorAbsent(url)) return undefined;
    throw error;
  }
}

/** Whether the sign-in door answers the contract's 404 for a path it does not serve. */
async function signInDoorAbsent(url: string): Promise<boolean> {
  const response = await fetch(`${url}${SIGN_IN_DOOR}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
    },
    body: "{}",
  });
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: unknown } } | undefined;
  return response.status === 404 && body?.error?.code === "not_found";
}

export async function bootServer(args: BootOptions): Promise<void> {
  const p = paths(args.state);
  const started = await startServer(args);
  const { controlSocket, authSecret } = started;
  const url = await waitForHealth(started, p);
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
  const ownerCookie = await signInOwner(url, previous.MARFA_OWNER_COOKIE);
  maskInActions(
    apiKey,
    managementKey,
    ownerCookie ?? "",
    TEST_OWNER.password,
    authSecret,
  );
  if (ownerCookie === undefined) {
    console.log(
      "[marfa-server] the target has no owner sign-in (its sign-in door answered 404 not_found); the env file carries no owner cookie",
    );
  }
  writeFileSync(
    p.env,
    renderEnvFile(
      url,
      {
        apiKey,
        managementKey,
        controlSocket,
        ownerCookie,
        authSecret,
      },
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
      `the server did not end within ${String(REFUSAL_BUDGET_MS)}ms, so the boot was not refused. Log tail:\n${logTail(p)}`,
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
 * than removed and its copy rows stay, so a deterministic blob
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
    p.stderr,
    p.clock,
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

/**
 * Copies the instance's data directory as it stands at one instant, as a
 * volume snapshot would, into the empty directory `to`. The server's whole
 * process group is stopped while the copy is taken and then resumed, so no
 * write lands between one file and the next. What the running process owns
 * rather than holds is left out.
 */
export function takeImage(state: string, to: string): void {
  const group = groupOf(state);
  signalGroup(group, "SIGSTOP");
  try {
    cpSync(state, to, {
      recursive: true,
      filter: (source) =>
        !/server\.(pid|log|exit)$/.test(source) &&
        !/\/control-directory$/.test(source) &&
        !/\/owner-session\.json(?:\.lock|\.[^/]+\.tmp)?$/.test(source),
    });
  } finally {
    signalGroup(group, "SIGCONT");
  }
}

/** What the server wrote to stdout, then to stderr. */
function printLog(state: string): void {
  const p = paths(state);
  for (const file of [p.log, p.stderr]) {
    if (existsSync(file)) process.stdout.write(readFileSync(file, "utf8"));
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

/**
 * Stops the server with `signal` and boots it again on the same data. How the
 * old process ended is printed first, because the boot removes its exit
 * record.
 */
export async function restartServer(
  args: BootOptions,
  signal: StopSignal,
): Promise<void> {
  const ended = await stopWithSignal(args.state, signal);
  console.log(`[marfa-server] previous exit ${JSON.stringify(ended)}`);
  await bootServer(args);
}

/** The private socket of the server running from a state directory. */
function controlSocketOf(state: string): string {
  const p = paths(state);
  const socket = existsSync(p.env)
    ? parseEnvFile(readFileSync(p.env, "utf8")).MARFA_CONTROL_SOCKET
    : undefined;
  if (!socket) {
    throw new Error(`no server has been booted from ${state}; run up first`);
  }
  return socket;
}

/** Asks the test hooks on the private socket, and says what they refused. */
async function hook(
  state: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  let answer;
  try {
    answer = await controlRequest(controlSocketOf(state), path, init);
  } catch (error) {
    throw new Error(
      `the server under ${state} did not answer on its private socket: ${String(error)}`,
    );
  }
  if (answer.status !== 200) {
    const refusal = answer.body.error as { message?: unknown } | undefined;
    throw new Error(
      `${path} answered ${String(answer.status)}${typeof refusal?.message === "string" ? `: ${refusal.message}` : ""}`,
    );
  }
  return answer.body;
}

/** Moves the clock forward and keeps the offset for the next boot. */
async function advanceClock(state: string, ms: number): Promise<void> {
  const moved = await hook(state, "/_control/test/clock", {
    method: "POST",
    body: { advance_ms: ms },
  });
  const offset = moved.offset_ms;
  if (typeof offset !== "number") {
    throw new Error("the clock route answered no offset");
  }
  writeFileSync(paths(state).clock, `${String(offset)}\n`);
  console.log(
    `[marfa-server] clock advanced by ${String(ms)} ms; offset ${String(offset)} ms; now ${String(moved.now)}`,
  );
}

async function setFault(state: string, spec: string): Promise<void> {
  const eq = spec.indexOf("=");
  const name = eq < 0 ? spec : spec.slice(0, eq);
  const arg = eq < 0 ? null : spec.slice(eq + 1);
  await hook(state, "/_control/test/faults", {
    method: "PUT",
    body: { name, arg },
  });
  console.log(`[marfa-server] fault set: ${spec}`);
}

async function clearFault(state: string, name?: string): Promise<void> {
  await hook(
    state,
    `/_control/test/faults${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
    { method: "DELETE" },
  );
  console.log(`[marfa-server] fault cleared: ${name ?? "all"}`);
}

/** What is armed, and how many callers wait at each hold. */
async function listFaults(state: string): Promise<string> {
  return JSON.stringify(await hook(state, "/_control/test/faults"));
}

async function runHooks(args: Args): Promise<void> {
  const [verb, operand] = args.words;
  if (args.command === "clock") {
    if ((verb === "pause" || verb === "resume") && operand === undefined) {
      console.log(
        JSON.stringify(
          await hook(args.state, "/_control/test/clock", {
            method: "POST",
            body: { paused: verb === "pause" },
          }),
        ),
      );
      return;
    }
    const ms = Number(operand);
    if (verb !== "advance" || operand === undefined || !Number.isFinite(ms)) {
      throw new Error("usage: clock [--state <dir>] advance <ms>|pause|resume");
    }
    await advanceClock(args.state, ms);
  } else if (verb === "set" && operand !== undefined) {
    await setFault(args.state, operand);
  } else if (verb === "clear") {
    await clearFault(args.state, operand);
  } else if (verb === "list") {
    console.log(await listFaults(args.state));
  } else {
    throw new Error(
      "usage: fault [--state <dir>] set <name>[=<arg>] | clear [<name>] | list",
    );
  }
}

// The command runs only when this file is the program, so the drill can
// import the two functions without booting anything.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = parseArgs(process.argv.slice(2));
  const boot: BootOptions = {
    state: args.state,
    port: args.port,
    env: args.env,
  };
  try {
    if (args.command === "up") await bootServer(boot);
    else if (args.command === "refused") await bootRefused(boot);
    else if (args.command === "restart") await restartServer(boot, args.signal);
    else if (args.command === "image") {
      if (args.to === undefined) throw new Error("image needs --to <dir>");
      takeImage(args.state, args.to);
      console.log(`[marfa-server] image of ${args.state} in ${args.to}`);
    } else if (args.command === "log") printLog(args.state);
    else if (args.command === "clock" || args.command === "fault") {
      await runHooks(args);
    } else if (args.command === "down") {
      await stopServer(args);
      await refuseToClearUnderALiveServer(args.state);
      clearState(args.state);
    } else status(args);
  } catch (error) {
    console.error(
      `[marfa-server] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
