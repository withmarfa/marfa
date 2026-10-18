import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, redactSetupProof, TEST_OWNER } from "./target.js";
import {
  groupOf,
  readExit,
  signalGroup,
  stopWithSignal,
  STOP_GRACE_MS,
  waitUntilGone,
  type ServerExit,
  type StopSignal,
} from "./server-process.js";

export type { ServerExit, StopSignal };

/**
 * A server of the fixture's own, booted from this checkout into a state
 * directory nothing else has touched, through the same script the run boots
 * its shared server with.
 *
 * The run's server is shared by every file and lives for the whole run, so
 * a door whose answer is the instance's whole history, rather than rows a
 * file can isolate under its own key, cannot be asserted against it: the
 * first file to reach the door decides what every later one sees, and a
 * re-run against the same server sees the last run. A boot here buys a
 * story that starts at the beginning.
 */
export interface FreshServer {
  apiUrl: string;
  /** Ordinary key explicitly holding management permissions and no content maps. */
  managementKey: string;
  controlSocket: string;
  ownerCookie: string;
  /** Ordinary key holding all content maps and the seven content/app permissions. */
  workingKey: string;
  /** The SQLite file this server writes to, so a fixture about the write
   *  lock can hold it from outside the process. */
  sqlitePath: string;
  /** The directory holding the SQLite file, the blob folder, the log and the
   *  env file. */
  stateDir: string;
  /**
   * Sends `name` to the server's process group and returns without waiting.
   * Which signal ended the server is for the fixture to say, so a stop
   * that is the subject of the test is not the harness's `SIGTERM`.
   */
  signal(name: StopSignal): void;
  /**
   * Waits for the server to end, however it did, and says how. For a server
   * that was signaled through `signal` or that stopped of its own accord;
   * rejects when it is still running after the grace a stopped server gets.
   */
  exit(): Promise<ServerExit>;
  /**
   * Stops the server's process without removing its state, runs
   * `whileStopped` while nothing is writing to the database file, and boots
   * the server again on the same state. The keys and the data stay; the port
   * does not, so `apiUrl` is the new one when this resolves.
   *
   * A boot that finds an emptied database mints its keys again, so
   * `managementKey` is read afresh and `workingKey` is minted again when the
   * management key changed.
   *
   * Takes the callback alone, or `{ signal, whileStopped, env }` to stop the
   * server with a signal other than `SIGTERM` or to boot it again under
   * another setting. Resolves with how the stopped
   * server ended. For a state the doors refuse to produce, which a fixture
   * arranges in the stored file and the next boot reads.
   */
  restart(
    arg?: (() => void | Promise<void>) | RestartOptions,
  ): Promise<ServerExit>;
  /**
   * Moves the server's clock forward by `ms`, through the target interface's
   * `clock advance`. Resolves with the output of the command; rejects when
   * the target refuses the step, as it does a negative one. The offset
   * survives `restart`, and the clock does not come back until `stop`.
   */
  advanceClock(ms: number): Promise<string>;
  /**
   * The sum of the steps `advanceClock` has taken: how far the target's clock
   * is ahead of this machine's, give or take the milliseconds the two differ
   * by. A client that judges the age of a sign-in takes it from here.
   */
  clockOffsetMs: number;
  /**
   * Arms a fault, through `fault set`: `hold:<point>` waits at a point until
   * cleared, `fail:<point>[=<arg>]` fails the target at a point once,
   * `deadline:<job>=<ms>` shortens a job's run deadline, and
   * `free:<volume>=<bytes>` sets the reported free space. The points are
   * stated in `conformance/README.md`, "Faults". The fault is cleared by
   * `clearFault`, by `restart`, and by `stop`, so none outlives the fixture
   * that set it.
   */
  setFault(spec: string): Promise<void>;
  /** Clears one fault, or every fault when no name is given. */
  clearFault(name?: string): Promise<void>;
  /** The faults armed now, and how many callers wait at each hold. */
  faults(): Promise<ArmedFault[]>;
  /**
   * Waits until `count` callers wait at the `hold:` fault named, as
   * `faults()` reports. Rejects after `timeoutMs` (60 seconds by default).
   */
  waitForHold(name: string, count?: number, timeoutMs?: number): Promise<void>;
  /** Stops the server and removes its state. Safe to call twice. */
  stop(): Promise<void>;
}

/** A fault the target has armed. */
export interface ArmedFault {
  name: string;
  arg: string | null;
  /** Callers waiting at a `hold:` fault now. */
  waiting: number;
  /** Times a `fail:` fault has acted. */
  fired: number;
}

export interface RestartOptions {
  signal?: StopSignal;
  whileStopped?: () => void | Promise<void>;
  /** Environment for this boot alone, over what the server was first booted
   *  with: a data directory started again under another setting. The boot
   *  after this one is back to the first. */
  env?: Record<string, string>;
}

/** A SHA-256 of each file SQLite keeps for one database, `absent` for a
 *  file that does not exist, so a boot that creates one shows. */
export interface DatabaseFiles {
  db: string;
  wal: string;
  shm: string;
}

/** A boot that ended instead of serving. */
export interface RefusedBoot extends ServerExit {
  /** Everything the server wrote: its log, then what it printed to stderr. */
  output: string;
  stateDir: string;
  sqlitePath: string;
  /** The database's files as `prepare` left them. */
  before: DatabaseFiles;
  /** The database's files once the server had ended. */
  after: DatabaseFiles;
  /** Removes the state. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The folder under the run's state directory where a fixture's own server
 * leaves its request log on the way out, for `check:statuses` to read.
 */
export const FRESH_SERVER_LOGS = "fresh-server-logs";

const conformanceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Past the script's own health budget, so its failure is reported rather
 *  than cut off. */
const BOOT_BUDGET_MS = 240_000;

/** Budgeted per script run a hook may wait on (a failed boot runs two), past
 *  the script's own bound and the mint, so the script's diagnostics are kept. */
export const FRESH_SERVER_TIMEOUT_MS = BOOT_BUDGET_MS + 30_000;

/** Every server booted or booting and not yet stopped, so a file's teardown
 *  can stop one whose boot outlived the hook that started it. */
const unstopped = new Set<() => Promise<void>>();

/** Stop every fixture server this file started, reporting every failure. */
export async function stopFreshServers(): Promise<void> {
  const stopped = await Promise.allSettled([...unstopped].map((s) => s()));
  const failures = stopped.flatMap((r) =>
    r.status === "rejected" ? [r.reason as unknown] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "fixture servers failed to stop");
  }
}

/** Not blocking: a worker held for a boot cannot retire its pooled
 *  connections, and the run's server closes one under the next request. */
export function runScript(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: conformanceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Bounded, so a script that hangs is killed rather than left behind.
      timeout: BOOT_BUDGET_MS,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (err) => {
      resolveRun({ status: null, output: `${output}${String(err)}` });
    });
    child.once("close", (status) => {
      resolveRun({ status, output });
    });
  });
}

async function mintWorkingKey(
  apiUrl: string,
  managementKey: string,
  label: string,
): Promise<string> {
  const response = await fetch(`${apiUrl}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: `${label}-working`, source: label }),
  });
  const body = (await response.json()) as { key?: unknown };
  if (response.status !== 201 || typeof body.key !== "string") {
    throw new Error(
      `the working key's mint answered ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
  return body.key;
}

/**
 * The environment the adapter script is started in: the caller's own, with
 * the port left to the kernel and the limiter and enrichment pinned off.
 * The settings a fixture names reach the target as `--env` arguments, which
 * win over these pins.
 */
function serverEnv(): NodeJS.ProcessEnv {
  return {
    // The script pins the port to `PORT` when one is set, and the run's
    // own server may already hold it. The limiter is pinned off for the
    // same kind of reason and in the same place: a fixture that does not
    // ask for it should not inherit one from whoever started the run.
    ...process.env,
    PORT: "",
    RATE_LIMIT_ENABLED: "false",
    MARFA_ENRICHMENT_ENABLED: "false",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
  };
}

/** `--env K=V` for each setting, the way the target interface names them. */
function envArgs(settings: Record<string, string>): string[] {
  return Object.entries(settings).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
}

function tsxBinary(): string {
  const tsx = resolve(conformanceRoot, "node_modules/.bin/tsx");
  if (!existsSync(tsx)) {
    throw new Error("no tsx binary in this checkout; run pnpm install first");
  }
  return tsx;
}

const SERVER_SCRIPT = resolve(conformanceRoot, "scripts/marfa-server.ts");

/**
 * Everything a server booted into `state` wrote: its log, the JSON lines on
 * its stdout, then what it printed to stderr. A fixture that holds the server
 * to what it must not log reads both, because the server warns on stderr.
 */
export function serverOutput(state: string): string {
  return ["server.log", "server.stderr"]
    .map((name) => join(state, name))
    .map((path) => (existsSync(path) ? readFileSync(path, "utf8") : ""))
    .join("");
}

/** Before `down`, which clears the log with the rest of the state. The run's
 *  server boots from the same checkout, so what this one answered is held to
 *  the same document. */
export function keepStatusLog(state: string): void {
  const destination = process.env.MARFA_STATUS_LOGS;
  const log = join(state, "server.log");
  if (destination !== undefined && destination !== "" && existsSync(log)) {
    mkdirSync(destination, { recursive: true });
    copyFileSync(log, join(destination, `${basename(state)}.log`));
  }
}

export async function bootFreshServer(
  label: string,
  /**
   * Extra environment for the server this boots, merged over the
   * script's own.
   *
   * A behavior that only appears under a setting cannot be asserted
   * against the shared server, and a fixture that tries either races the
   * default or changes it for every other file on the same instance.
   */
  extraEnv: Record<string, string> = {},
): Promise<FreshServer> {
  const tsx = tsxBinary();
  const state = mkdtempSync(join(tmpdir(), `marfa-${label}-`));
  const run = (
    command: "up" | "down" | "restart",
    more: Record<string, string> = {},
    ...options: string[]
  ) =>
    runScript(
      tsx,
      [
        SERVER_SCRIPT,
        command,
        "--state",
        state,
        ...envArgs({ ...extraEnv, ...more }),
        ...options,
      ],
      serverEnv(),
    );
  /** One of the adapter's commands that takes no setting. */
  const adapter = (...words: string[]) =>
    runScript(tsx, [SERVER_SCRIPT, ...words, "--state", state], serverEnv());
  /** Whether a fault may be armed, so `stop` clears it before it stops. */
  let armed = false;

  const booting = run("up");
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // `down` finds the server through the pid file `up` writes, so one
      // still booting is waited for rather than left to come up after.
      await booting;
      // A held run would keep the server from stopping, and a fault is the
      // fixture's own: none outlives it.
      if (armed) await adapter("fault", "clear").catch(() => undefined);
      keepStatusLog(state);
      const down = await run("down");
      if (down.status !== 0) {
        throw new Error(
          `could not stop the server booted into ${state}, whose state is left in place:\n${down.output}`,
        );
      }
      rmSync(state, { recursive: true, force: true });
    })().finally(() => unstopped.delete(stop));
    return stopping;
  };
  unstopped.add(stop);

  const up = await booting;
  if (up.status !== 0) {
    // A failed boot may have left a server running, since the script spawns
    // it before the health wait; `stop` finds it through the pid file.
    const stopped = await stop().then(
      () => "",
      (err: unknown) => `\n${String(err)}`,
    );
    throw new Error(
      `could not boot a server into ${state}:\n${up.output}${stopped}`,
    );
  }

  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  const apiUrl = env.MARFA_API_URL;
  const managementKey = env.MARFA_MANAGEMENT_KEY;
  if (!apiUrl || !managementKey) {
    await stop();
    throw new Error(`the boot into ${state} wrote an incomplete env file`);
  }
  let workingKey: string;
  try {
    workingKey = await mintWorkingKey(apiUrl, env.MARFA_API_KEY!, label);
  } catch (err) {
    await stop();
    throw err;
  }

  // When the last signal went out, so that `ServerExit.ms` can say how long
  // the stop took.
  let signaledAt: number | undefined;
  const signal = (name: StopSignal): void => {
    signaledAt = Date.now();
    signalGroup(groupOf(state), name);
  };
  const exit = async (): Promise<ServerExit> => {
    if (!(await waitUntilGone(groupOf(state), Date.now() + STOP_GRACE_MS))) {
      throw new Error(
        `the server under ${state} was still running ${String(STOP_GRACE_MS)}ms after it was asked to end`,
      );
    }
    return readExit(state, signaledAt, false);
  };
  const listArmedFaults = async (): Promise<ArmedFault[]> => {
    const listed = await adapter("fault", "list");
    const line = listed.output
      .split("\n")
      .find((candidate) => candidate.startsWith("{"));
    if (listed.status !== 0 || line === undefined) {
      throw new Error(`the target did not list its faults:\n${listed.output}`);
    }
    return (JSON.parse(line) as { faults: ArmedFault[] }).faults;
  };
  const server: FreshServer = {
    apiUrl,
    managementKey,
    controlSocket: env.MARFA_CONTROL_SOCKET!,
    ownerCookie: env.MARFA_OWNER_COOKIE!,
    workingKey,
    sqlitePath: join(state, "marfa.db"),
    stateDir: state,
    signal,
    exit,
    async restart(arg) {
      const options: RestartOptions =
        typeof arg === "function" ? { whileStopped: arg } : (arg ?? {});
      const name = options.signal ?? "SIGTERM";
      // The new process starts with no fault armed.
      armed = false;
      let ended: ServerExit;
      let again: { status: number | null; output: string };
      if (options.whileStopped === undefined) {
        again = await run("restart", options.env, "--signal", name.slice(3));
        const previous = /previous exit (\{.*\})/.exec(again.output);
        if (again.status !== 0 || previous === null) {
          throw new Error(
            `could not restart the server in ${state}:\n${again.output}`,
          );
        }
        ended = JSON.parse(previous[1]!) as ServerExit;
      } else {
        signaledAt = Date.now();
        ended = await stopWithSignal(state, name);
        await options.whileStopped();
        again = await run("up", options.env);
        if (again.status !== 0) {
          throw new Error(
            `could not boot the server again into ${state}:\n${again.output}`,
          );
        }
      }
      const after = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
      if (!after.MARFA_API_URL || !after.MARFA_MANAGEMENT_KEY) {
        throw new Error(
          `the second boot into ${state} wrote an incomplete env`,
        );
      }
      server.apiUrl = after.MARFA_API_URL;
      server.controlSocket = after.MARFA_CONTROL_SOCKET!;
      server.ownerCookie = after.MARFA_OWNER_COOKIE!;
      if (after.MARFA_MANAGEMENT_KEY !== server.managementKey) {
        server.managementKey = after.MARFA_MANAGEMENT_KEY;
        server.workingKey = await mintWorkingKey(
          server.apiUrl,
          after.MARFA_API_KEY!,
          label,
        );
      }
      return ended;
    },
    clockOffsetMs: 0,
    async advanceClock(ms) {
      const moved = await adapter("clock", "advance", String(ms));
      if (moved.status !== 0) {
        throw new Error(
          `the target did not move its clock by ${String(ms)} ms:\n${moved.output}`,
        );
      }
      server.clockOffsetMs += ms;
      return moved.output;
    },
    async setFault(spec) {
      const set = await adapter("fault", "set", spec);
      if (set.status !== 0) {
        throw new Error(`the target refused the fault ${spec}:\n${set.output}`);
      }
      armed = true;
    },
    async clearFault(name) {
      const cleared = await adapter("fault", "clear", ...(name ? [name] : []));
      if (cleared.status !== 0) {
        throw new Error(`the target did not clear a fault:\n${cleared.output}`);
      }
    },
    faults: listArmedFaults,
    async waitForHold(name, count = 1, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let seen = 0;
      for (;;) {
        seen =
          (await listArmedFaults()).find((fault) => fault.name === name)
            ?.waiting ?? 0;
        if (seen >= count) return;
        if (Date.now() > deadline) {
          throw new Error(
            `${String(seen)} of ${String(count)} callers waited at ${name} after ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    },
    stop,
  };
  return server;
}

const DATABASE_SUFFIXES = { db: "", wal: "-wal", shm: "-shm" } as const;

/** What `bootRefused` takes. */
export interface RefusedBootOptions {
  /**
   * Arranges the state before the server is started: `sqlitePath` is where
   * it will look for its database, which a fixture fills, damages or leaves
   * out. A fixture about a setting leaves it out and the server finds no
   * database at all.
   */
  prepare?: (sqlitePath: string, stateDir: string) => void | Promise<void>;
  extraEnv?: Record<string, string>;
  /**
   * The `NODE_ENV` the server is started under, which every other boot
   * leaves unset. Naming one also leaves `MARFA_AUTH_SECRET` and
   * `MARFA_AUTH_BASE_URL` to `extraEnv`, so a rule that holds only in
   * production reads what the fixture gives it.
   */
  nodeEnv?: string;
}

function fingerprint(sqlitePath: string): DatabaseFiles {
  const of = (suffix: string): string => {
    const path = `${sqlitePath}${suffix}`;
    return existsSync(path)
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : "absent";
  };
  return {
    db: of(DATABASE_SUFFIXES.db),
    wal: of(DATABASE_SUFFIXES.wal),
    shm: of(DATABASE_SUFFIXES.shm),
  };
}

/**
 * Starts a server of the fixture's own that is meant to refuse to start, and
 * waits for it to end, which `bootFreshServer` cannot do: it waits for
 * `/health` and a server that ended is an error there.
 *
 * Resolves with how it ended, what it logged, and the database's files from
 * before and after, so a fixture can say both what the refusal was and that
 * it changed nothing. No credential is minted. Rejects when the server is
 * still up a minute in.
 */
export async function bootRefused(
  label: string,
  options: RefusedBootOptions = {},
): Promise<RefusedBoot> {
  const tsx = tsxBinary();
  const state = mkdtempSync(join(tmpdir(), `marfa-${label}-`));
  const sqlitePath = join(state, "marfa.db");
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= Promise.resolve(
      rmSync(state, { recursive: true, force: true }),
    ).finally(() => unstopped.delete(stop));
    return stopping;
  };
  unstopped.add(stop);

  try {
    await options.prepare?.(sqlitePath, state);
    const before = fingerprint(sqlitePath);
    const refused = await runScript(
      tsx,
      [
        SERVER_SCRIPT,
        "refused",
        "--state",
        state,
        ...(options.nodeEnv === undefined
          ? []
          : ["--node-env", options.nodeEnv]),
        ...envArgs(options.extraEnv ?? {}),
      ],
      serverEnv(),
    );
    if (refused.status !== 0) {
      throw new Error(
        `the server booted into ${state} was not refused:\n${refused.output}`,
      );
    }
    const ended = readExit(state, undefined, false);
    return {
      ...ended,
      output: redactSetupProof(serverOutput(state)),
      stateDir: state,
      sqlitePath,
      before,
      after: fingerprint(sqlitePath),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** What the token door answers a device code's poll. */
export interface DevicePoll {
  status: number;
  body: {
    error?: string;
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
  };
}

/**
 * An app's device authorization flow, started on a server of the fixture's
 * own and held between its steps, so a fixture can ask the token door at each
 * of them.
 */
export interface DeviceFlow {
  /** The client the app registered for itself. */
  clientId: string;
  /** The scope the registration answered. The registration names no scope. */
  registeredScope: string;
  /** Seconds a poller must leave between polls, as the initiation answered. */
  interval: number;
  /** One poll of the token door, as an app makes it: no credential. */
  poll(): Promise<DevicePoll>;
  /**
   * The owner signs in on the sign-in surface's own origin and approves
   * everything the consent screen offers.
   */
  approve(): Promise<void>;
  /** The owner signs in and denies the code on the consent screen. */
  deny(): Promise<void>;
  /** The code a device's own request carries. */
  deviceCode: string;
}

/**
 * Registers a native app and requests a device code for the claimed owner to approve.
 * Without explicit scopes it requests content and seven permissions, every
 * permission but `instance.read`, `instance.maintain`, `connectors.manage`,
 * `blobs.manage` and `keys.manage`, which a fixture names when it needs them.
 * The app registers the device grant and the refresh grant, no redirect URI
 * and no response type, unless `options` names others.
 */
export async function startDeviceFlow(
  server: FreshServer,
  scopes?: readonly string[],
  options: {
    grantTypes?: readonly string[];
    redirectUris?: readonly string[];
    responseTypes?: readonly string[];
  } = {},
): Promise<DeviceFlow> {
  const owner = TEST_OWNER;

  const discovery = (await (
    await fetch(`${server.apiUrl}/.well-known/oauth-authorization-server/auth`)
  ).json()) as {
    registration_endpoint: string;
    device_authorization_endpoint: string;
    token_endpoint: string;
    scopes_supported: string[];
  };
  const registered = (await (
    await fetch(discovery.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "conformance",
        application_type: "native",
        grant_types: options.grantTypes ?? [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
        response_types: options.responseTypes ?? [],
        ...(options.redirectUris === undefined
          ? {}
          : { redirect_uris: options.redirectUris }),
        token_endpoint_auth_method: "none",
      }),
    })
  ).json()) as { client_id: string; scope: string };

  const code = (await (
    await fetch(discovery.device_authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registered.client_id,
        scope: (
          scopes ??
          discovery.scopes_supported.filter(
            (scope) =>
              ![
                "instance.read",
                "instance.maintain",
                "connectors.manage",
                "blobs.manage",
                "keys.manage",
              ].includes(scope),
          )
        ).join(" "),
      }),
    })
  ).json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    interval: number;
  };
  const origin = new URL(code.verification_uri_complete).origin;

  const ownerSession = async (): Promise<string> => {
    const signIn = await fetch(`${origin}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(owner),
    });
    if (signIn.status !== 200) {
      throw new Error(
        `the owner could not sign in, so nothing can be decided: ${String(signIn.status)}`,
      );
    }
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      signIn.headers.get("set-cookie") ?? "",
    )?.[1];
    if (cookie === undefined) {
      throw new Error("the owner's sign-in set no session cookie");
    }
    return cookie;
  };

  return {
    clientId: registered.client_id,
    registeredScope: registered.scope,
    interval: code.interval,
    deviceCode: code.device_code,
    async poll() {
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: registered.client_id,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as DevicePoll["body"],
      };
    },
    async approve() {
      const cookie = await ownerSession();
      // Redirects are not followed, so a refusal, such as the per-address
      // lookup limit, fails here rather than as a pending poll later.
      const consent = await fetch(
        `${origin}/auth/device/consent?user_code=${encodeURIComponent(code.user_code)}`,
        { headers: { cookie }, redirect: "manual" },
      );
      if (consent.status !== 200) {
        throw new Error(
          `the consent screen was refused: ${String(consent.status)} ${consent.headers.get("location") ?? ""}`,
        );
      }
      const html = await consent.text();
      const form = new URLSearchParams({
        user_code: code.user_code,
        decision: "approve",
      });
      for (const scope of new Set(
        [...html.matchAll(/name="scopes"[^>]*value="([^"]+)"/g)].map(
          (m) => m[1]!,
        ),
      )) {
        form.append("scopes", scope);
      }
      const approved = await fetch(`${origin}/auth/device/consent`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      if (approved.status !== 200) {
        throw new Error(
          `the owner's approval was refused: ${String(approved.status)}`,
        );
      }
    },
    async deny() {
      const cookie = await ownerSession();
      const denied = await fetch(`${origin}/auth/device/consent`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          user_code: code.user_code,
          decision: "deny",
        }),
      });
      if (denied.status !== 200) {
        throw new Error(
          `the owner's denial was refused: ${String(denied.status)}`,
        );
      }
    },
  };
}

/**
 * An access token of the kind an app holds once a person approves it, on a
 * server of the fixture's own, with the client that holds it.
 *
 * Reached the way a person reaches one: `startDeviceFlow`, the owner's
 * approval, and the client's poll, answered. A token like this is the one
 * credential a fixture can hold that an app holds, so a door that treats an
 * app differently from a key is asserted through it.
 *
 */
export async function approvedApp(
  server: FreshServer,
  scopes?: readonly string[],
): Promise<{ token: string; clientId: string; refreshToken?: string }> {
  const flow = await startDeviceFlow(server, scopes);
  await flow.approve();
  // The code's first poll, so no polling interval applies to it yet.
  const answer = await flow.poll();
  if (answer.body.access_token === undefined) {
    throw new Error("the approved device flow answered no access token");
  }
  return {
    token: answer.body.access_token,
    clientId: flow.clientId,
    refreshToken: answer.body.refresh_token,
  };
}

/**
 * The access token an app's refresh token is exchanged for: a new token
 * under the same grant. The app must have asked for `offline_access`.
 */
export async function refreshedAppToken(
  server: FreshServer,
  clientId: string,
  refreshToken: string,
): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  const body = (await response.json()) as DevicePoll["body"];
  if (response.status !== 200 || body.access_token === undefined) {
    throw new Error(
      `the refresh was refused: ${String(response.status)} ${JSON.stringify(body)}`,
    );
  }
  return body.access_token;
}

/** The access token of `approvedApp`, for a fixture that needs no client id. */
export async function approvedAppToken(
  server: FreshServer,
  scopes?: readonly string[],
): Promise<string> {
  return (await approvedApp(server, scopes)).token;
}
