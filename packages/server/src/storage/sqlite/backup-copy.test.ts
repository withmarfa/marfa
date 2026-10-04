import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "./connection.js";

/**
 * What an owner's backup of a running instance's data directory restores to.
 *
 * Three ways of taking the copy, each of which a person has:
 * - an image of the whole directory at one instant (a volume or APFS
 *   snapshot, which is what Time Machine and a host's disk snapshot take),
 *   modeled by stopping the writer while the directory is copied;
 * - the directory as a crash leaves it, modeled by killing the writer;
 * - a copy that reads the files one after another while the instance runs,
 *   which is the unsafe one unless a read transaction is held open for its
 *   duration.
 */

const WRITER = fileURLToPath(new URL("./backup-writer.ts", import.meta.url));
const roots: string[] = [];
const writers: ChildProcess[] = [];

afterEach(() => {
  for (const writer of writers.splice(0)) writer.kill("SIGKILL");
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "backup-copy-"));
  roots.push(root);
  return root;
}

interface Writer {
  child: ChildProcess;
  /** The highest number the writer has printed, which it has committed. */
  acked: () => number;
}

async function startWriter(directory: string): Promise<Writer> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", WRITER, directory],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  writers.push(child);
  let acked = 0;
  let partial = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) acked = Math.max(acked, Number(line));
  });
  const writer = { child, acked: () => acked };
  await until(() => acked > 0);
  return writer;
}

async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Restored {
  /** Why the copy is not a working database, when it is not. */
  broken?: string;
  rows: number;
  highest: number;
}

/** Open a copy the way the server does, and look at what it holds. */
async function restore(directory: string): Promise<Restored> {
  let connection: Awaited<ReturnType<typeof createConnection>>;
  try {
    connection = await createConnection(join(directory, "marfa.db"));
  } catch (error) {
    return { broken: `will not open: ${String(error)}`, rows: 0, highest: 0 };
  }
  try {
    const check = await connection.raw.execute("PRAGMA integrity_check");
    const answer = check.rows[0]?.integrity_check;
    const verdict = typeof answer === "string" ? answer : "no answer";
    if (verdict !== "ok") {
      return { broken: `integrity_check: ${verdict}`, rows: 0, highest: 0 };
    }
    const held = await connection.raw.execute(
      "SELECT count(*) AS rows, coalesce(max(n), 0) AS highest FROM probe",
    );
    return {
      rows: Number(held.rows[0]?.rows),
      highest: Number(held.rows[0]?.highest),
    };
  } catch (error) {
    return { broken: `unreadable: ${String(error)}`, rows: 0, highest: 0 };
  } finally {
    await connection.close();
  }
}

/** Every write acknowledged before the copy began is there, with no gap. */
function expectWhole(restored: Restored, ackedBefore: number): void {
  expect(restored.broken).toBeUndefined();
  expect(restored.highest).toBeGreaterThanOrEqual(ackedBefore);
  expect(restored.rows).toBe(restored.highest);
}

/** The files of a data directory a copier reads one after another. */
function copyOneAfterAnother(from: string, to: string): Promise<void> {
  return (async () => {
    mkdirSync(to, { recursive: true });
    for (const name of ["marfa.db", "marfa.db-wal"]) {
      if (existsSync(join(from, name)))
        cpSync(join(from, name), join(to, name));
      // Time passes between one file and the next, as it does for a tool
      // that reads a database and then the many files beside it.
      await pause(40);
    }
  })();
}

describe("copying a running instance's data directory", () => {
  // The witness for everything below: the same copy, taken the same way,
  // without a read transaction held, is not a restorable database.
  it("restores a copy that reads the files one after another across a checkpoint to a database that is not whole", async () => {
    const root = freshRoot();
    const live = join(root, "live");
    const { raw, close } = await createConnection(join(live, "marfa.db"));
    await raw.execute(
      "CREATE TABLE probe (n INTEGER PRIMARY KEY, pad TEXT NOT NULL)",
    );
    const pad = "x".repeat(3000);
    let acked = 0;
    const write = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        acked += 1;
        await raw.execute({
          sql: "INSERT INTO probe (n, pad) VALUES (?, ?)",
          args: [acked, pad],
        });
      }
    };

    await write(50);
    const ackedBefore = acked;
    cpSync(join(live, "marfa.db"), join(root, "plain.db"));
    await write(50);
    // A checkpoint, and the reset of the log that follows it.
    await raw.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    await write(10);
    const copy = join(root, "plain");
    mkdirSync(copy);
    cpSync(join(root, "plain.db"), join(copy, "marfa.db"));
    cpSync(join(live, "marfa.db-wal"), join(copy, "marfa.db-wal"));
    await close();

    const restored = await restore(copy);

    const whole =
      restored.broken === undefined &&
      restored.highest >= ackedBefore &&
      restored.rows === restored.highest;
    expect(whole).toBe(false);
  });

  it("restores an image of the directory taken while the writer is stopped, with every write acknowledged before it", async () => {
    const root = freshRoot();
    const live = join(root, "live");
    mkdirSync(live);
    const writer = await startWriter(live);

    for (let trial = 0; trial < 8; trial += 1) {
      await pause(30 + trial * 17);
      const ackedBefore = writer.acked();
      writer.child.kill("SIGSTOP");
      const image = join(root, `image-${String(trial)}`);
      cpSync(live, image, { recursive: true });
      writer.child.kill("SIGCONT");

      expectWhole(await restore(image), ackedBefore);
    }
  }, 120_000);

  it("restores the directory a killed writer leaves, with every write acknowledged before the kill", async () => {
    const root = freshRoot();
    const live = join(root, "live");
    mkdirSync(live);

    for (let trial = 0; trial < 3; trial += 1) {
      const writer = await startWriter(live);
      await pause(100 + trial * 60);
      const ackedBefore = writer.acked();
      writer.child.kill("SIGKILL");
      await new Promise((resolve) => writer.child.once("exit", resolve));
      const image = join(root, `killed-${String(trial)}`);
      cpSync(live, image, { recursive: true });

      expectWhole(await restore(image), ackedBefore);
    }
  }, 120_000);

  it("restores a copy that reads the files one after another while a read transaction is held, with every write acknowledged before it", async () => {
    const root = freshRoot();
    const live = join(root, "live");
    mkdirSync(live);
    const writer = await startWriter(live);

    for (let trial = 0; trial < 12; trial += 1) {
      await pause(20 + trial * 11);
      const ackedBefore = writer.acked();
      // What `sqlite3 marfa.db "BEGIN; SELECT 1 FROM sqlite_master;"` held
      // open does: the log is not restarted while a reader is on it.
      const reader = createClient({ url: `file:${join(live, "marfa.db")}` });
      await reader.execute("BEGIN");
      await reader.execute("SELECT count(*) FROM probe");
      const copy = join(root, `held-${String(trial)}`);
      try {
        await copyOneAfterAnother(live, copy);
      } finally {
        await reader.execute("COMMIT");
        reader.close();
      }

      expectWhole(await restore(copy), ackedBefore);
    }
  }, 120_000);

  it("leaves a stopped instance's database in one file, which restores whole without a log beside it", async () => {
    const root = freshRoot();
    const live = join(root, "live");
    const { raw, close } = await createConnection(join(live, "marfa.db"));
    await raw.execute(
      "CREATE TABLE probe (n INTEGER PRIMARY KEY, pad TEXT NOT NULL)",
    );
    for (let n = 1; n <= 40; n += 1) {
      await raw.execute({
        sql: "INSERT INTO probe (n, pad) VALUES (?, ?)",
        args: [n, "x".repeat(500)],
      });
    }
    // A write the log still holds, since nothing has checkpointed yet.
    expect(statSync(join(live, "marfa.db-wal")).size).toBeGreaterThan(0);
    await close();

    const log = join(live, "marfa.db-wal");
    expect(existsSync(log) ? statSync(log).size : 0).toBe(0);
    const copy = join(root, "stopped");
    mkdirSync(copy);
    cpSync(join(live, "marfa.db"), join(copy, "marfa.db"));

    const restored = await restore(copy);

    expectWhole(restored, 40);
  });
});
