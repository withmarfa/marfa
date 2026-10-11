import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { HeldLock } from "./held-lock.js";
import { witnessWriteAdmission } from "./write-admission.js";

it("admits a post-release witness despite a short competing writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marfa-admission-"));
  const path = join(directory, "store.db");
  const prior = await HeldLock.take(path);
  await prior.release();
  const competing = await HeldLock.take(path);
  const runSqlite = promisify(execFile);
  let releasing: Promise<void> | undefined;
  try {
    await expect(
      runSqlite("sqlite3", [
        "-bail",
        "-cmd",
        ".timeout 0",
        path,
        "BEGIN IMMEDIATE;",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("database is locked"),
    });
    releasing = new Promise<void>((resolve, reject) => {
      setTimeout(() => void competing.release().then(resolve, reject), 100);
    });
    await witnessWriteAdmission(path);
    await releasing;
  } finally {
    await competing.release();
    await releasing;
    rmSync(directory, { recursive: true, force: true });
  }
});
