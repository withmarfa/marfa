import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * The folders a contract run makes, and everything else it must undo, so a
 * run that passes, fails or is interrupted leaves nothing in the temporary
 * folder.
 *
 * Every folder a fixture makes comes from `tempFolder`. A test process keeps
 * one run folder of its own, and each folder is made inside it, so removing
 * the run folder at the end removes a folder whose removal nobody registered.
 * What a fixture starts or mounts (a disk image, a process) is undone through
 * `onCleanup`, and runs before the folders go.
 *
 * Removal runs after each file (`temp-folder-teardown.ts`), when the process
 * exits, and on `SIGINT`, `SIGTERM` and `SIGHUP`.
 */

/**
 * Names the file the run's processes list their run folders in, so
 * `temp-folder-run.ts` can fail the run when one outlives its process.
 */
export const RUN_LIST_VARIABLE = "MARFA_TEST_RUN_LIST";

interface TempFolders {
  /** This process's run folder, made when the first folder is asked for. */
  folder: string | undefined;
  /** Folders made outside the run folder, because a fixture needs them there. */
  elsewhere: string[];
  actions: (() => void)[];
  handlersInstalled: boolean;
}

const KEY = Symbol.for("marfa.conformance.temp-folders");

// One state per process, not per module: Vitest evaluates a module again for
// every file, and every evaluation would otherwise add its own handlers.
const state = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  folder: undefined,
  elsewhere: [],
  actions: [],
  handlersInstalled: false,
} satisfies TempFolders) as TempFolders;

// A socket path is limited to about a hundred characters on a Mac, and the
// folders that hold one sit inside this one.
const RUN_FOLDER_PREFIX = "marfa-r-";

/**
 * Makes a folder under this process's run folder (or, with `parent`, under
 * that folder instead) and returns its real path. It is removed, whatever it
 * holds, after the file, at exit and on an interrupt.
 */
export function tempFolder(
  prefix: string,
  options: { parent?: string } = {},
): string {
  install();
  if (options.parent !== undefined) {
    const made = realpathSync(mkdtempSync(join(options.parent, prefix)));
    state.elsewhere.push(made);
    return made;
  }
  return realpathSync(mkdtempSync(join(runFolder(), prefix)));
}

function runFolder(): string {
  if (state.folder !== undefined) return state.folder;
  const made = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), RUN_FOLDER_PREFIX)),
  );
  state.folder = made;
  const list = process.env[RUN_LIST_VARIABLE];
  if (list !== undefined && existsSync(list)) appendFileSync(list, `${made}\n`);
  return made;
}

/**
 * Registers something a fixture started or attached that outlives its
 * folders: a disk image to detach, a process to stop. Actions run last in,
 * first out, before any folder is removed, and one that throws does not stop
 * the rest.
 */
export function onCleanup(action: () => void): void {
  install();
  state.actions.push(action);
}

/**
 * Removes a folder made by `tempFolder` before its turn comes, unlocking it
 * first. Refuses a path this process did not make, so a wrong path cannot take
 * anything else with it.
 */
export function removeTempFolder(path: string): void {
  if (!existsSync(path)) return;
  const real = realpathSync(path);
  const mine =
    (state.folder !== undefined && real.startsWith(state.folder + sep)) ||
    state.elsewhere.includes(real);
  if (!mine) throw new Error(`${path} was not made by tempFolder`);
  unlockAndRemove(real);
}

/**
 * Undoes everything this process registered, then removes every folder it
 * made. Throws what could not be undone, after trying everything.
 */
export function removeTempFolders(): void {
  const failures: unknown[] = [];
  for (const action of state.actions.splice(0).reverse()) {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  }
  const folders = [
    ...(state.folder === undefined ? [] : [state.folder]),
    ...state.elsewhere.splice(0),
  ];
  state.folder = undefined;
  for (const folder of folders) {
    try {
      unlockAndRemove(folder);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "the run's cleanup did not finish");
  }
}

/**
 * Removes a folder a fixture may have locked: clears the immutable flag,
 * removes access rules that deny deletion, gives the owner access back to
 * everything, then removes it. Acts on the folder given and what is inside
 * it, and follows no link out of it.
 */
export function unlockAndRemove(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
  if (process.platform === "darwin") {
    spawnSync("chflags", ["-R", "nouchg", path]);
    spawnSync("chmod", ["-R", "-N", path]);
  }
  spawnSync("chmod", ["-R", "u+rwx", path]);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Detaches a disk image mounted at `mount`, forcing it when the first try is
 * refused. Does nothing when nothing is mounted there.
 */
export function detachImage(mount: string): void {
  if (process.platform !== "darwin") return;
  if (!mounted(mount)) return;
  if (spawnSync("hdiutil", ["detach", mount]).status === 0) return;
  const forced = spawnSync("hdiutil", ["detach", "-force", mount]);
  if (forced.status !== 0 && mounted(mount)) {
    throw new Error(
      `could not detach the disk image at ${mount}: ${String(forced.stderr)}`,
    );
  }
}

function mounted(mount: string): boolean {
  const listed = spawnSync("hdiutil", ["info"], { encoding: "utf8" });
  return listed.stdout.split("\n").some((line) => line.endsWith(`\t${mount}`));
}

/**
 * Registers the detaching of a disk image fixture has just attached at
 * `mount`. Call it straight after the attach.
 */
export function detachImageAtCleanup(mount: string): void {
  onCleanup(() => {
    detachImage(mount);
  });
}

/**
 * Registers the stopping of a process the fixture started, if it is still
 * running when the cleanup comes. Goes by the child the fixture holds, whose
 * process ID is not reused while the fixture has not seen it end.
 */
export function stopChildAtCleanup(child: {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): void {
  onCleanup(() => {
    if (child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    stopNow(child.pid);
  });
}

/** `SIGTERM`, then `SIGKILL` when the process is still there after a few seconds. */
function stopNow(pid: number): void {
  if (!isRunning(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
    if (waitUntilGone(pid, 5_000)) return;
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  waitUntilGone(pid, 5_000);
}

/** Whether the process still runs: one that ended and has not been waited for
 *  is still listed, and is not running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

function waitUntilGone(pid: number, budgetMs: number): boolean {
  const end = Date.now() + budgetMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (isRunning(pid)) {
    if (Date.now() > end) return false;
    Atomics.wait(pause, 0, 0, 50);
  }
  return true;
}

function removeQuietly(): void {
  try {
    removeTempFolders();
  } catch {
    // Nothing is left to report to once the process is ending.
  }
}

function install(): void {
  if (state.handlersInstalled) return;
  state.handlersInstalled = true;
  process.on("exit", removeQuietly);
  // A runner that handles a signal itself, and a worker it ends in its own
  // time, would never reach `exit` for a process that is being stopped, so
  // the folders go at the signal. When nothing else listens, the signal ends
  // the process as it would have.
  for (const [signal, number] of [
    ["SIGINT", 2],
    ["SIGTERM", 15],
    ["SIGHUP", 1],
  ] as const) {
    process.once(signal, () => {
      removeQuietly();
      if (process.listenerCount(signal) === 0) process.exit(128 + number);
    });
  }
}
