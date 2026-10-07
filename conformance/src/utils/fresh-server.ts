import { spawn } from "node:child_process";
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
import { parseEnvFile } from "./target.js";

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
  /** The key the bootstrap mint answered with. */
  operatorKey: string;
  /** A key the operator key minted naming no permissions, maps or claims,
   *  so it holds every content family and every permission
   *  (`keys-and-oauth.md` 2). */
  workingKey: string;
  /** The SQLite file this server writes to, so a fixture about the write
   *  lock can hold it from outside the process. */
  sqlitePath: string;
  /**
   * Stops the server's process without removing its state, runs
   * `whileStopped` while nothing is writing to the database file, and boots
   * the server again on the same state. The keys and the data stay; the port
   * does not, so `apiUrl` is the new one when this resolves.
   *
   * For a state the doors refuse to produce, which a fixture arranges in the
   * stored file and the next boot reads.
   */
  restart(whileStopped?: () => void | Promise<void>): Promise<void>;
  /** Stops the server and removes its state. Safe to call twice. */
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The grace a stopped server gets before it is killed outright. */
const STOP_GRACE_MS = 20_000;

/**
 * Stops the process a state directory's pid file names, leaving the state.
 * The server runs as its own process group, so the group is signaled.
 */
async function stopProcess(state: string): Promise<void> {
  const pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the pid file under ${state} names no process`);
  }
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (processAlive(pid)) {
    signal("SIGKILL");
    const killDeadline = Date.now() + STOP_GRACE_MS;
    while (processAlive(pid) && Date.now() < killDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (processAlive(pid)) {
      throw new Error(`process ${String(pid)} survived SIGKILL`);
    }
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
  operatorKey: string,
  label: string,
): Promise<string> {
  const response = await fetch(`${apiUrl}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${operatorKey}`,
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
  const tsx = resolve(conformanceRoot, "node_modules/.bin/tsx");
  if (!existsSync(tsx)) {
    throw new Error("no tsx binary in this checkout; run pnpm install first");
  }
  const script = resolve(conformanceRoot, "scripts/marfa-server.ts");
  const state = mkdtempSync(join(tmpdir(), `marfa-${label}-`));
  const run = (command: "up" | "down") =>
    runScript(tsx, [script, command, "--state", state], {
      // The script pins the port to `PORT` when one is set, and the run's
      // own server may already hold it. The limiter is pinned off for the
      // same kind of reason and in the same place: a fixture that does not
      // ask for it should not inherit one from whoever started the run.
      // `extraEnv` comes last, so a fixture that does ask still wins.
      ...process.env,
      PORT: "",
      RATE_LIMIT_ENABLED: "false",
      MARFA_ENRICHMENT_ENABLED: "false",
      MARFA_ENRICHMENT_OCR_ENABLED: "false",
      ...extraEnv,
    });

  const booting = run("up");
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // `down` finds the server through the pid file `up` writes, so one
      // still booting is waited for rather than left to come up after.
      await booting;
      // Before `down`, which clears the log with the rest of the state. The
      // run's server boots from the same checkout, so what this one answered
      // is held to the same document.
      const destination = process.env.MARFA_STATUS_LOGS;
      const log = join(state, "server.log");
      if (destination !== undefined && destination !== "" && existsSync(log)) {
        mkdirSync(destination, { recursive: true });
        copyFileSync(log, join(destination, `${basename(state)}.log`));
      }
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
  const operatorKey = env.MARFA_OPERATOR_KEY;
  if (!apiUrl || !operatorKey) {
    await stop();
    throw new Error(`the boot into ${state} wrote an incomplete env file`);
  }
  let workingKey: string;
  try {
    workingKey = await mintWorkingKey(apiUrl, operatorKey, label);
  } catch (err) {
    await stop();
    throw err;
  }
  const server: FreshServer = {
    apiUrl,
    operatorKey,
    workingKey,
    sqlitePath: join(state, "marfa.db"),
    async restart(whileStopped) {
      await stopProcess(state);
      await whileStopped?.();
      const again = await run("up");
      if (again.status !== 0) {
        throw new Error(
          `could not boot the server again into ${state}:\n${again.output}`,
        );
      }
      const after = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
      if (!after.MARFA_API_URL) {
        throw new Error(`the second boot into ${state} wrote no address`);
      }
      server.apiUrl = after.MARFA_API_URL;
    },
    stop,
  };
  return server;
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
  /** Seconds a poller must leave between polls, as the initiation answered. */
  interval: number;
  /** One poll of the token door, as an app makes it: no credential. */
  poll(): Promise<DevicePoll>;
  /**
   * The owner signs in on the sign-in surface's own origin and approves
   * everything the consent screen offers.
   */
  approve(): Promise<void>;
}

/**
 * Starts a device flow the way an app does, over HTTP alone: the operator key
 * creates the owner, a native client registers, and the device-authorization
 * door is asked for a code. Nobody has approved it yet.
 *
 * The app asks for `scopes`, or for every scope the instance supports when
 * none are named.
 *
 * The owner is created here, and an instance has one, so this runs once per
 * fresh server: a second call is refused `409 owner_exists` and throws.
 */
export async function startDeviceFlow(
  server: FreshServer,
  scopes?: readonly string[],
): Promise<DeviceFlow> {
  const owner = { email: "a@example.com", password: "correct horse battery" };
  const created = await fetch(`${server.apiUrl}/owner`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.operatorKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(owner),
  });
  if (created.status !== 201) {
    throw new Error(
      `the owner could not be created, so nobody can approve an app: ${String(created.status)}`,
    );
  }

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
        grant_types: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json()) as { client_id: string };

  const code = (await (
    await fetch(discovery.device_authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registered.client_id,
        scope: (scopes ?? discovery.scopes_supported).join(" "),
      }),
    })
  ).json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    interval: number;
  };
  const origin = new URL(code.verification_uri_complete).origin;

  return {
    clientId: registered.client_id,
    interval: code.interval,
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
      const signIn = await fetch(`${origin}/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(owner),
      });
      if (signIn.status !== 200) {
        throw new Error(
          `the owner could not sign in, so nothing can be approved: ${String(signIn.status)}`,
        );
      }
      const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
        signIn.headers.get("set-cookie") ?? "",
      )?.[1];
      if (cookie === undefined) {
        throw new Error("the owner's sign-in set no session cookie");
      }
      const consent = await fetch(
        `${origin}/auth/device/consent?user_code=${encodeURIComponent(code.user_code)}`,
        { headers: { cookie } },
      );
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
 * It creates the owner, as `startDeviceFlow` does, so it runs once per fresh
 * server.
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
