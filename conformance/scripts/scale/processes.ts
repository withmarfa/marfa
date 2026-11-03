/**
 * Running the release `marfa` binary the way a person's machine does, for the
 * steps that time its commands, and reading what its processes cost.
 *
 * A step stops only the processes it started, by their process IDs and those
 * of the children found below them: never by name or pattern, since other
 * jobs and sessions may run the same binary.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  descendantsOf,
  parseProcStat,
  parsePsCpuTime,
} from "../../src/utils/scale/cpu.js";
import { connect, sleep } from "./context.js";

export function binaryPath(): string {
  const binary = process.env.MARFA_DEVICE_BIN;
  if (binary === undefined || binary === "") {
    throw new Error("MARFA_DEVICE_BIN names the release marfa binary");
  }
  return binary;
}

/**
 * The environment of one `marfa` command: the booted server, a key (the
 * instance's own unless a step names another), no keychain and no telemetry,
 * and a folder registry of the step's own when it names one, so the machine's
 * own folders are never touched.
 */
export function cliEnv(
  options: { key?: string; registry?: string } = {},
): NodeJS.ProcessEnv {
  const { url, key } = connect();
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OTEL_|MARFA_OTEL_|MARFA_POSTHOG_|MARFA_FOLDER_)/.test(name)) {
      delete env[name];
    }
  }
  Object.assign(env, {
    MARFA_API_URL: url,
    MARFA_API_KEY: options.key ?? key,
    MARFA_NO_KEYCHAIN: "1",
    OTEL_SDK_DISABLED: "true",
  });
  if (options.registry !== undefined) {
    env.MARFA_FOLDER_REGISTRY = options.registry;
  }
  return env;
}

export interface Ran {
  /** Null where the command was stopped at its time limit. */
  exit: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

const KEEP = 4_000_000;

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    child.once("close", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends a process this module started, and the children found below it. */
async function endTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  let below: number[] = [];
  try {
    below = descendantsOf(pid, listProcesses());
  } catch {
    // Without a process list only the child itself is ended.
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (!(await waitForExit(child, 10_000))) child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
  for (const pid of below) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It ended between the check and the signal.
      }
    }
  }
}

/** One command, run to its end or stopped at `limitMs`. */
export async function runBounded(
  args: string[],
  env: NodeJS.ProcessEnv,
  limitMs: number,
): Promise<Ran> {
  const started = performance.now();
  const child = spawn(binaryPath(), args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length < KEEP) stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  const spawnError = new Promise<never>((_, fail) => child.once("error", fail));
  const ended = Promise.race([waitForExit(child, limitMs), spawnError]);
  const finished = await ended;
  if (!finished) await endTree(child);
  return {
    exit: finished ? child.exitCode : null,
    timedOut: !finished,
    ms: performance.now() - started,
    stdout,
    stderr,
  };
}

/** A command left running, whose lines are handed on as they come. */
export class HeldProcess {
  private constructor(
    private readonly child: ChildProcess,
    private readonly tail: { stderr: string },
  ) {}

  static start(
    args: string[],
    env: NodeJS.ProcessEnv,
    onLine: (line: string) => void,
  ): HeldProcess {
    const child = spawn(binaryPath(), args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = { stderr: "" };
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let end = pending.indexOf("\n");
      while (end >= 0) {
        onLine(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      tail.stderr = (tail.stderr + chunk.toString()).slice(-4_000);
    });
    // An error event with no listener would end this process.
    child.once("error", (error) => {
      tail.stderr += String(error);
    });
    return new HeldProcess(child, tail);
  }

  get pid(): number {
    if (this.child.pid === undefined)
      throw new Error("the command did not start");
    return this.child.pid;
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get stderr(): string {
    return this.tail.stderr;
  }

  stop(): Promise<void> {
    return endTree(this.child);
  }
}

export interface ProcessReading {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  /** Resident memory in MB, where the platform tells it. */
  rssMb: number | null;
}

let ticksPerSecond: number | undefined;

function clockTicks(): number {
  if (ticksPerSecond === undefined) {
    try {
      ticksPerSecond =
        Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" })) ||
        100;
    } catch {
      ticksPerSecond = 100;
    }
  }
  return ticksPerSecond;
}

/** Every process on the machine: from `/proc` on Linux, from `ps` elsewhere. */
export function listProcesses(): ProcessReading[] {
  if (process.platform === "linux") {
    const readings: ProcessReading[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
        if (stat === null) continue;
        readings.push({
          pid: stat.pid,
          ppid: stat.ppid,
          cpuSeconds: stat.ticks / clockTicks(),
          rssMb: null,
        });
      } catch {
        // The process ended while the list was read.
      }
    }
    return readings;
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,cputime="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const readings: ProcessReading[] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
    const seconds = parsePsCpuTime(cpu ?? "");
    if (seconds === null || pid === undefined || ppid === undefined) continue;
    readings.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuSeconds: seconds,
      rssMb: Number(rss) / 1024,
    });
  }
  return readings;
}

function residentMb(pid: number): number | null {
  try {
    const kb = /^VmRSS:\s+(\d+) kB/m.exec(
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    return kb === null ? null : Number(kb[1]) / 1024;
  } catch {
    return null;
  }
}

/** A process and everything below it, with what each has used so far. */
export function readTree(root: number): ProcessReading[] {
  const all = listProcesses();
  const members = new Set([root, ...descendantsOf(root, all)]);
  return all
    .filter((reading) => members.has(reading.pid))
    .map((reading) => ({
      ...reading,
      rssMb:
        process.platform === "linux" ? residentMb(reading.pid) : reading.rssMb,
    }));
}

/** Waits for `ready` to be true, or `limitMs` to pass; returns whether it was. */
export async function waitUntil(
  ready: () => boolean,
  limitMs: number,
  pollMs = 100,
): Promise<boolean> {
  const started = performance.now();
  while (!ready()) {
    if (performance.now() - started > limitMs) return false;
    await sleep(pollMs);
  }
  return true;
}
