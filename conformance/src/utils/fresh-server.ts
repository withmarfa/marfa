import { spawnSync } from "node:child_process";
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
  /** A key the operator key minted naming no maps, so it holds every
   *  content family and every permission (`keys-and-oauth.md` 2). */
  workingKey: string;
  /** The SQLite file this server writes to, so a fixture about the write
   *  lock can hold it from outside the process. */
  sqlitePath: string;
  /** Stops the server and removes its state. Safe to call twice. */
  stop(): void;
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
    spawnSync(tsx, [script, command, "--state", state], {
      cwd: conformanceRoot,
      encoding: "utf8",
      // The script pins the port to `PORT` when one is set, and the run's
      // own server may already hold it. The limiter is pinned off for the
      // same kind of reason and in the same place: a fixture that does not
      // ask for it should not inherit one from whoever started the run.
      // `extraEnv` comes last, so a fixture that does ask still wins.
      env: {
        ...process.env,
        PORT: "",
        RATE_LIMIT_ENABLED: "false",
        ...extraEnv,
      },
      // Bounded, because the call blocks the worker and vitest's own hook
      // timeout cannot fire while it does.
      timeout: BOOT_BUDGET_MS,
    });

  const up = run("up");
  if (up.status !== 0) {
    // The script spawns the server detached before the health wait and
    // the mint, either of which can fail, so a failed boot may have left
    // one running; `down` finds it through the pid file, which is why the
    // directory goes only after.
    run("down");
    rmSync(state, { recursive: true, force: true });
    throw new Error(
      `could not boot a server into ${state}:\n${up.stdout}${up.stderr}`,
    );
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Before `down`, which clears the log with the rest of the state. The
    // run's server boots from the same checkout, so what this one answered
    // is held to the same document.
    const destination = process.env.MARFA_STATUS_LOGS;
    const log = join(state, "server.log");
    if (destination !== undefined && destination !== "" && existsSync(log)) {
      mkdirSync(destination, { recursive: true });
      copyFileSync(log, join(destination, `${basename(state)}.log`));
    }
    const down = run("down");
    if (down.status !== 0) {
      throw new Error(
        `could not stop the server booted into ${state}, whose state is left in place:\n${down.stdout}${down.stderr}`,
      );
    }
    rmSync(state, { recursive: true, force: true });
  };

  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  const apiUrl = env.MARFA_API_URL;
  const operatorKey = env.MARFA_OPERATOR_KEY;
  if (!apiUrl || !operatorKey) {
    stop();
    throw new Error(`the boot into ${state} wrote an incomplete env file`);
  }
  let workingKey: string;
  try {
    workingKey = await mintWorkingKey(apiUrl, operatorKey, label);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    apiUrl,
    operatorKey,
    workingKey,
    sqlitePath: join(state, "marfa.db"),
    stop,
  };
}

/**
 * An access token of the kind an app holds once a person approves it, on a
 * server of the fixture's own.
 *
 * Reached the way a person reaches one, over HTTP alone: the operator key
 * creates the owner, a native client registers, the device flow starts, the
 * owner signs in on the sign-in surface's own origin and approves everything
 * the consent screen offers, and the client's poll is answered. A token like
 * this is the one credential a fixture can hold that an app holds, so a door
 * that treats an app differently from a key is asserted through it.
 *
 * The owner is created here, and an instance has one, so this runs once per
 * fresh server: a second call is refused `409 owner_exists` and throws.
 */
export async function approvedAppToken(server: FreshServer): Promise<string> {
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
        scope: discovery.scopes_supported.join(" "),
      }),
    })
  ).json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
  };

  const origin = new URL(code.verification_uri_complete).origin;
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
    [...html.matchAll(/name="scopes"[^>]*value="([^"]+)"/g)].map((m) => m[1]!),
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

  const token = (await (
    await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: registered.client_id,
      }),
    })
  ).json()) as { access_token?: string };
  if (token.access_token === undefined) {
    throw new Error("the approved device flow answered no access token");
  }
  return token.access_token;
}
