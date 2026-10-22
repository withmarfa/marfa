// @ts-check
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MarfaCore } from "../index.js";

/** @param {string} path */
function digest(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : null;
}

/** A store this build refuses, as another build's queue would leave it. */
function refusedStore(/** @type {string} */ path, /** @type {boolean} */ unsent) {
  // Made in a process of its own, whose exit lets go of the writer role.
  const made = spawnSync(process.execPath, [
    "-e",
    "require(process.argv[1]).MarfaCore.open(process.argv[2])",
    fileURLToPath(new URL("../index.js", import.meta.url)),
    path,
  ]);
  assert.equal(made.status, 0, made.stderr.toString());
  const db = new DatabaseSync(path);
  if (unsent) {
    db.exec(`INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
             VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')`);
  }
  db.exec("ALTER TABLE queue RENAME COLUMN follows TO after_write");
  db.close();
}

/** @param {() => unknown} call */
function refusal(call) {
  try {
    call();
  } catch (error) {
    return /** @type {{ code?: string, unsent?: number }} */ (error);
  }
  assert.fail("the call was not refused");
}

/**
 * Holds the store's writer lock from another process, as another app on the
 * same store would, until the returned function lets it go.
 * @param {string} path
 */
async function holdWriter(path) {
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const lock = new DatabaseSync(process.argv[1]);
       lock.exec("BEGIN EXCLUSIVE");
       process.stdout.write("held\\n");
       process.stdin.on("end", () => process.exit(0));
       process.stdin.resume();`,
      `${path}.writer-lock`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("exit", reject);
  });
  return async () => {
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    holder.stdin.end();
    await exited;
  };
}

test("a refused store is replaced only while nothing is unsent and no other process writes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-replace-"));
  try {
    const path = join(dir, "copy.sqlite");
    refusedStore(path, true);
    assert.equal(refusal(() => MarfaCore.open(path)).code, "wrong_schema");

    const before = digest(path);
    const unsent = refusal(() => MarfaCore.replaceRefused(path));
    assert.equal(unsent.code, "wrong_schema");
    assert.equal(unsent.unsent, 1);
    assert.equal(digest(path), before);

    const db = new DatabaseSync(path);
    db.exec("DELETE FROM queue");
    db.close();
    const answered = digest(path);

    const release = await holdWriter(path);
    try {
      assert.equal(
        refusal(() => MarfaCore.replaceRefused(path)).code,
        "reading_handle",
      );
      assert.equal(digest(path), answered);
      assert.equal(refusal(() => MarfaCore.open(path)).code, "wrong_schema");
    } finally {
      await release();
    }

    const core = MarfaCore.replaceRefused(path);
    assert.deepEqual(core.queue(), []);
    assert.equal(
      refusal(() => MarfaCore.replaceRefused(join(dir, "absent.sqlite"))).code,
      "invalid",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
