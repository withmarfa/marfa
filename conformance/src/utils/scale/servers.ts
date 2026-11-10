import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The process a state directory's pid file names, if it is running. */
export function liveServerIn(state: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

/** The servers one run started, so that it stops those and no other. */
export class StartedServers {
  private readonly states: string[] = [];

  /** Refuses a state directory a server is already running in. */
  free(state: string): void {
    const pid = liveServerIn(state);
    if (pid !== null) {
      throw new Error(
        `a server (process ${pid}) is already running in ${state}; it is not this run's to use or stop`,
      );
    }
  }

  /** Records a server as this run's before it is started, since a boot that fails part way still leaves a process. */
  starting(state: string): void {
    this.free(state);
    this.states.push(state);
  }

  async stopAll(stop: (state: string) => Promise<void>): Promise<string[]> {
    const failures: string[] = [];
    for (const state of this.states) {
      try {
        await stop(state);
      } catch (error) {
        failures.push(`${state}: ${String(error)}`);
      }
    }
    return failures;
  }
}
