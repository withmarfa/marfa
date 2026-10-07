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
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

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
child.once("exit", (code, signal) => {
  writeFileSync(exitFile, JSON.stringify({ code, signal, at: Date.now() }));
  process.exit(code ?? 1);
});
