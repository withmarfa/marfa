import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { TestContext } from "../../client/types.js";
import { keychainEnv } from "../../utils/keychain.js";
import { createTestContext } from "../../utils/setup.js";

/**
 * The `marfa` binary, driven as the reference client against the server the
 * run booted.
 *
 * Every scenario here is a person or an agent at a terminal: the binary is
 * spawned with `--json`, its stdout is the answer, its exit code is the
 * verdict, and a refusal is the one JSON object it prints on stderr. The
 * server is reached directly only for a witness (the root document, the
 * published document) or for the person's half of a sign-in, never for the
 * thing a scenario asserts the binary did.
 */

/** The built binary. The same one the device fixtures drive. */
export function requireBinary(): string {
  const binary = process.env.MARFA_DEVICE_BIN;
  if (binary === undefined || binary === "") {
    throw new Error(
      "MARFA_DEVICE_BIN is unset. Build the binary (`cargo build -p marfa-cli` under core/) and point this at it; the CI job does both.",
    );
  }
  return binary;
}

/** What one invocation came back with. */
export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** The refusal envelope the binary prints under `--json`. */
export interface Refusal {
  error: {
    code: string;
    message: string;
    server: { status: number | null; code: string; details?: unknown } | null;
    retry_after_seconds: number | null;
  };
  exit: number;
}

/**
 * What the child sees of this process's environment: the system's own
 * variables and nothing of the developer's (a `MARFA_DB`, a kept
 * `MARFA_API_KEY`), so what a scenario passes is all the binary has.
 */
const INHERITED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** The long-running children a file started, killed when the file ends. */
const held: ChildProcess[] = [];

export class Cli {
  constructor(
    readonly binary: string,
    readonly url: string,
    readonly key: string | undefined,
  ) {}

  /** The same binary under another credential, or under none. */
  as(key: string | undefined): Cli {
    return new Cli(this.binary, this.url, key);
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of INHERITED) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.MARFA_API_URL = this.url;
    if (this.key !== undefined) env.MARFA_API_KEY = this.key;
    return { ...env, ...keychainEnv() };
  }

  /** Runs the binary and answers whatever it did, refusal or not. */
  async run(
    args: string[],
    options: { stdin?: string } = {},
  ): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: this.env(),
        stdio: [
          options.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
      if (options.stdin !== undefined) {
        child.stdin!.end(options.stdin);
      }
    });
  }

  /**
   * Runs with `--json` and answers the parsed stdout. A non-zero exit throws
   * with the envelope, because a scenario that meant to be refused asks
   * through `refused` instead, and one that did not should stop here. An
   * empty stdout throws too: a binary that printed nothing is not proven
   * by its exit code alone. A door that answers `204` is printed as
   * `null`, which is an answer, so a scenario that reads one follows it
   * with the read that shows what the door did.
   */
  async json<T = unknown>(
    args: string[],
    options: { stdin?: string } = {},
  ): Promise<T> {
    const outcome = await this.run(["--json", ...args], options);
    if (outcome.code !== 0) {
      throw new Error(
        `marfa ${args.join(" ")} exited ${String(outcome.code)}: ${outcome.stderr.trim()}`,
      );
    }
    const text = outcome.stdout.trim();
    if (text === "") {
      throw new Error(`marfa ${args.join(" ")} exited 0 and printed nothing`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `marfa ${args.join(" ")} printed something that is not JSON: ${text.slice(0, 300)}`,
      );
    }
  }

  /**
   * Runs with `--json` expecting a refusal, and answers the envelope and the
   * exit code. A zero exit throws: a scenario asserting a refusal must not
   * pass on a success.
   */
  async refused(
    args: string[],
    options: { stdin?: string } = {},
  ): Promise<{ code: number; envelope: Refusal }> {
    const outcome = await this.run(["--json", ...args], options);
    if (outcome.code === 0) {
      throw new Error(
        `marfa ${args.join(" ")} succeeded where a refusal was expected: ${outcome.stdout.slice(0, 300)}`,
      );
    }
    const text = outcome.stderr.trim();
    let envelope: Refusal;
    try {
      envelope = JSON.parse(text) as Refusal;
    } catch {
      throw new Error(
        `marfa ${args.join(" ")} exited ${String(outcome.code)} without the JSON envelope: ${text.slice(0, 300)}`,
      );
    }
    return { code: outcome.code, envelope };
  }

  /**
   * Starts a long-running command and leaves it to the caller, who reads
   * its stdout and stderr; the child is killed when the file ends if the
   * scenario did not see it out, so a failing scenario does not leave a
   * binary polling a server that is about to stop.
   */
  hold(args: string[]): ChildProcess {
    const child = spawn(this.binary, ["--json", ...args], {
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    held.push(child);
    return child;
  }
}

/** Ends every held child a file started; part of every file's cleanup. */
export function releaseHeld(): void {
  for (const child of held.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export interface CliContext {
  ctx: TestContext;
  /** The binary under this file's own key, with its own source. */
  cli: Cli;
  /** The binary under the operator key, for the operator doors. */
  operator: Cli;
  apiUrl: string;
  apiKey: string;
}

/**
 * A key of this file's own, minted the way every other suite mints one, so
 * every row the scenarios write is attributable to this file and torn down
 * with it.
 */
export async function cliContext(file: string): Promise<CliContext> {
  const { ctx, apiUrl, apiKey } = await createTestContext("cli", file);
  const binary = requireBinary();
  const operatorKey = process.env.MARFA_OPERATOR_KEY;
  if (operatorKey === undefined || operatorKey === "") {
    throw new Error("MARFA_OPERATOR_KEY is unset; `pnpm marfa:up` writes it");
  }
  return {
    ctx,
    cli: new Cli(binary, apiUrl, apiKey),
    operator: new Cli(binary, apiUrl, operatorKey),
    apiUrl,
    apiKey,
  };
}

/** A unique tag or title for a scenario, so a search finds only its own. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The item inside a write door's answer. */
export interface ItemEnvelope {
  item: {
    id: string;
    type: string;
    state: string;
    tier: string;
    version: number;
    source: string;
    source_id?: string;
    properties: Record<string, unknown>;
  };
  metadata?: { tags: string[] };
  acknowledged?: boolean;
}

/**
 * The child's exit code once it has closed. A child that closed before
 * this was asked answers at once, because the event it fired is not
 * fired again and a scenario waiting for it would time out with nothing
 * to say.
 */
export async function once(
  process: ChildProcess,
  event: "close" | "exit",
): Promise<number | null> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return process.exitCode;
  }
  return new Promise((resolve) => {
    process.once(event, (code) => resolve(code));
  });
}
