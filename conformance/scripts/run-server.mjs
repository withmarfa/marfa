/**
 * The process a booted server hangs from, so that how the server ended is
 * kept when nothing is waiting for it.
 *
 *   node run-server.mjs <exit-file> <command> [args...]
 *
 * `marfa-server.ts up` starts this as the leader of a process group of its
 * own, and the server joins that group. A signal sent to the group reaches
 * the server and not this process's own death, because this process handles
 * the signals the fixtures send and does nothing with them. When the server
 * ends, this writes `{"code":N,"signal":null,"at":<ms>}` to the exit file and
 * ends with it. A `SIGKILL` to the group takes this process too, so a killed
 * server leaves no exit file.
 *
 * Nothing else stops a server whose run was cancelled or whose worktree was
 * removed before `down`, so this does, about every 30 seconds
 * (`CONFORMANCE_SERVER_WATCH_MS` sets the interval): when the state
 * directory (the exit file's folder) or the server's working directory is
 * gone, or when no request has reached the server for
 * `CONFORMANCE_SERVER_IDLE_MS` (default 30 minutes, `0` for no limit), it
 * sends the group `SIGTERM`, as `down` does, and `SIGKILL` if the group is
 * still there 20 seconds later. A request is a line with a `request_id` in
 * the server's stdout, which is the log file; the file's modification time
 * would also move for the server's own background lines.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";

const [exitFile, command, ...args] = process.argv.slice(2);
if (exitFile === undefined || command === undefined) {
  console.error("usage: run-server.mjs <exit-file> <command> [args...]");
  process.exit(2);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => undefined);
}

const child = spawn(command, args, { stdio: "inherit" });
child.once("error", (error) => {
  console.error(`could not start ${command}: ${String(error)}`);
  process.exit(127);
});
/** A whole number of milliseconds from the environment, else the default. */
function msSetting(name, fallback, { allowZero }) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && (value > 0 || (allowZero && value === 0)))
    return value;
  console.error(
    `[run-server] ignoring ${name}=${raw}; using ${String(fallback)}`,
  );
  return fallback;
}

const WATCH_MS = msSetting("CONFORMANCE_SERVER_WATCH_MS", 30_000, {
  allowZero: false,
});
const IDLE_MS = msSetting("CONFORMANCE_SERVER_IDLE_MS", 30 * 60_000, {
  allowZero: true,
});
const KILL_AFTER_MS = 20_000;
const stateDir = dirname(exitFile);
const serverDir = process.cwd();
const logFile = `${stateDir}/server.log`;
let logOffset = existsSync(logFile) ? sizeOf(logFile) : 0;
let lastRequestAt = Date.now();
const controlDir = readControlDirectory();

/** The control socket's folder, which only `down` or the next `up` removes. */
function readControlDirectory() {
  try {
    const directory = readFileSync(`${stateDir}/control-directory`, "utf8");
    if (
      dirname(directory) === realpathSync(tmpdir()) &&
      /^marfa-control-[A-Za-z0-9]+$/.test(basename(directory))
    )
      return directory;
  } catch {
    // No marker: nothing to remove later.
  }
  return undefined;
}

/** With the state directory gone, nothing else can find this folder. */
function removeOrphanedControlDirectory() {
  if (controlDir === undefined || existsSync(stateDir)) return;
  try {
    const stat = lstatSync(controlDir);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.()
    )
      rmSync(controlDir, { recursive: true });
  } catch {
    // Already gone.
  }
}

function sizeOf(file) {
  const fd = openSync(file, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

/** Notes the time of the newest request line appended since the last look. */
function noteRequests() {
  if (!existsSync(logFile)) return;
  const fd = openSync(logFile, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < logOffset) logOffset = 0;
    if (size === logOffset) return;
    const buffer = Buffer.alloc(size - logOffset);
    const read = readSync(fd, buffer, 0, buffer.length, logOffset);
    logOffset += read;
    if (buffer.subarray(0, read).includes('"request_id"')) {
      lastRequestAt = Date.now();
    }
  } finally {
    closeSync(fd);
  }
}

function whyToStop() {
  if (!existsSync(stateDir)) return "its state directory is gone";
  if (!existsSync(serverDir)) return "its working directory is gone";
  noteRequests();
  if (IDLE_MS > 0 && Date.now() - lastRequestAt > IDLE_MS) {
    return `no request for ${String(IDLE_MS)} ms`;
  }
  return undefined;
}

function signalGroup(name) {
  try {
    process.kill(-process.pid, name);
  } catch {
    // The group is already gone.
  }
}

const watch = setInterval(() => {
  let reason;
  try {
    reason = whyToStop();
  } catch {
    reason = undefined;
  }
  if (reason === undefined) return;
  clearInterval(watch);
  console.error(`[run-server] stopping the server: ${reason}`);
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), KILL_AFTER_MS);
}, WATCH_MS);
watch.unref();

child.once("exit", (code, signal) => {
  clearInterval(watch);
  if (existsSync(stateDir))
    writeFileSync(exitFile, JSON.stringify({ code, signal, at: Date.now() }));
  removeOrphanedControlDirectory();
  process.exit(code ?? 1);
});
