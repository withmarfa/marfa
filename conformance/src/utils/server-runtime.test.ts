import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverRuntime } from "../../scripts/marfa-server.js";

const supervisor = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/run-server.mjs",
);
const serverRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/server",
);

function rowsInFileAlone(database: string, copy: string): number {
  copyFileSync(database, copy);
  const db = new DatabaseSync(copy);
  try {
    return Number(
      db.prepare("SELECT count(*) AS count FROM notes").get()!.count,
    );
  } finally {
    db.close();
  }
}

describe("the supervised server runtime", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "records the server's clean exit when %s arrives during synchronous work",
    async (signal) => {
      const state = mkdtempSync(join(tmpdir(), "marfa-runtime-stop-"));
      const script = join(state, "busy.ts");
      const entered = join(state, "entered");
      const finished = join(state, "finished");
      const exitFile = join(state, "exit.json");
      const database = join(state, "notes.db");
      const wal = `${database}-wal`;
      writeFileSync(
        script,
        [
          'import { writeFileSync } from "node:fs";',
          'import { DatabaseSync } from "node:sqlite";',
          "const db = new DatabaseSync(process.argv[5]!);",
          'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id TEXT)");',
          'db.exec("PRAGMA wal_checkpoint(TRUNCATE)");',
          'db.prepare("INSERT INTO notes(id) VALUES (?)").run("acknowledged");',
          "const signal: NodeJS.Signals = process.argv[2] as NodeJS.Signals;",
          "process.prependListener(signal, () => {",
          '  writeFileSync(process.argv[3]!, "entered");',

          '  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");',
          "  db.close();",
          '  writeFileSync(process.argv[4]!, "finished");',
          "  process.exit(0);",
          "});",
          'writeFileSync(process.argv[3]!, "entered");',
          'process.stdout.write("ready\\n");',
          // A synchronous write prevents the runtime wrapper's signal
          // acknowledgement from running until the work finishes.
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);",
          "setInterval(() => undefined, 1000);",
        ].join("\n"),
      );
      const child = spawn(
        process.execPath,
        [
          supervisor,
          exitFile,
          ...serverRuntime([script, signal, entered, finished, database]),
        ],
        { cwd: serverRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise<void>((done) =>
        child.once("close", () => done()),
      );
      try {
        await new Promise<void>((ready, reject) => {
          let output = "";
          let errors = "";
          const timer = setTimeout(
            () => reject(new Error(`runtime did not become ready: ${errors}`)),
            10_000,
          );
          child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
            output += chunk;
            if (output.includes("ready\n")) {
              clearTimeout(timer);
              ready();
            }
          });
          child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
            errors += chunk;
          });
          child.once("close", () => {
            clearTimeout(timer);
            reject(new Error(`runtime exited before readiness: ${errors}`));
          });
          child.once("error", reject);
        });
        expect(statSync(wal).size).toBeGreaterThan(0);
        expect(rowsInFileAlone(database, join(state, "before.db"))).toBe(0);
        process.kill(-child.pid!, signal);
        await closed;
        expect(readFileSync(entered, "utf8")).toBe("entered");
        const recorded = JSON.parse(readFileSync(exitFile, "utf8")) as {
          code: number | null;
          signal: string | null;
        };
        expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
        expect(recorded).toMatchObject({ code: 0, signal: null });
        expect(rowsInFileAlone(database, join(state, "after.db"))).toBe(1);
        expect(readFileSync(finished, "utf8")).toBe("finished");
      } finally {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await closed;
        rmSync(state, { recursive: true, force: true });
      }
    },
  );
});
