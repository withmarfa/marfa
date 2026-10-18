import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The signals a fixture stops a server with: the two a stop answers to, and
 *  the one a crash is. */
export type StopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export const STOP_SIGNALS: readonly StopSignal[] = [
  "SIGTERM",
  "SIGINT",
  "SIGKILL",
];

/**
 * How a server ended. `code` is the exit status and `signal` the signal that
 * ended it, one of them null. A server killed with `SIGKILL` takes its
 * supervisor with it and leaves no status, so it reads `code` null and
 * `signal` `SIGKILL`. `ms` is the time from the last signal sent to the end,
 * `0` when none was sent.
 */
export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

/** The grace a stopped server gets before it is killed outright. */
export const STOP_GRACE_MS = 20_000;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process group a state directory's pid file names. The server runs as
 *  its own group, so the group is what is signaled. */
export function groupOf(state: string): number {
  const pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the pid file under ${state} names no process`);
  }
  return pid;
}

export function signalGroup(group: number, name: NodeJS.Signals): void {
  try {
    process.kill(-group, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Waits for the group to end; false when it is still there at `deadline`. */
export async function waitUntilGone(
  group: number,
  deadline: number,
): Promise<boolean> {
  while (processAlive(group) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processAlive(group);
}

/** What the supervisor recorded of the server's end, once the group is gone. */
export function readExit(
  state: string,
  signaledAt: number | undefined,
  killed: boolean,
): ServerExit {
  const file = join(state, "server.exit");
  if (!existsSync(file)) {
    if (!killed) {
      throw new Error(
        `the server under ${state} ended and left no exit record`,
      );
    }
    return {
      code: null,
      signal: "SIGKILL",
      ms: Date.now() - (signaledAt ?? Date.now()),
    };
  }
  const record = JSON.parse(readFileSync(file, "utf8")) as {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: number;
  };
  return {
    code: record.code,
    signal: record.signal,
    ms: Math.max(0, record.at - (signaledAt ?? record.at)),
  };
}

/**
 * Sends `name` to the server's process group and waits for it to end,
 * killing it outright when the signal does not end it within the grace. The
 * pid file stays, so the next boot finds the old group gone. Says how the
 * server ended.
 */
export async function stopWithSignal(
  state: string,
  name: StopSignal,
): Promise<ServerExit> {
  const group = groupOf(state);
  const signaledAt = Date.now();
  signalGroup(group, name);
  let killed = name === "SIGKILL";
  if (!(await waitUntilGone(group, Date.now() + STOP_GRACE_MS))) {
    // Not ended by the signal asked for: killed, and said so, so a fixture
    // about a clean stop sees a stop that was not one.
    signalGroup(group, "SIGKILL");
    killed = true;
    if (!(await waitUntilGone(group, Date.now() + STOP_GRACE_MS))) {
      throw new Error(`process ${String(group)} survived SIGKILL`);
    }
  }
  return readExit(state, signaledAt, killed);
}
