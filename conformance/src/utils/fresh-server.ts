import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
   * A behaviour that only appears under a setting cannot be asserted
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
      // own server may already hold it.
      env: { ...process.env, PORT: "", ...extraEnv },
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
