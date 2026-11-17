// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MarfaCore } from "../index.js";

/** A store holding one write the server has not taken and one fetched file. */
function storeWithOneUnsent(/** @type {string} */ path) {
  // Made in a process of its own, whose exit lets go of the writer role.
  const made = spawnSync(process.execPath, [
    "-e",
    "require(process.argv[1]).MarfaCore.open(process.argv[2])",
    fileURLToPath(new URL("../index.js", import.meta.url)),
    path,
  ]);
  assert.equal(made.status, 0, made.stderr.toString());
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
           VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')`);
  db.close();
  mkdirSync(`${path}.blobs`);
  writeFileSync(join(`${path}.blobs`, "fetched"), "bytes");
}

/** @param {() => unknown} call */
function refusal(call) {
  try {
    call();
  } catch (error) {
    return /** @type {{ code?: string, unsent?: number | null }} */ (
      error
    );
  }
  assert.fail("the call was not refused");
}

test("a store is removed only with the confirmation of the writes it was shown", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-remove-"));
  try {
    const path = join(dir, "copy.sqlite");
    storeWithOneUnsent(path);
    writeFileSync(join(dir, "notes.txt"), "kept");
    const before = readdirSync(dir).sort();
    const shown = MarfaCore.readUnsent(path);
    assert.deepEqual(
      shown.writes.map((write) => write.id),
      ["q1"],
    );
    assert.equal(typeof shown.confirmation, "string");

    for (const agreed of ["", "q1", MarfaCore.readUnsent(join(dir, "none.sqlite")).confirmation]) {
      const differs = refusal(() => MarfaCore.removeStore(path, agreed));
      assert.equal(differs.code, "unsent_differs");
      assert.equal(differs.unsent, 1);
      assert.deepEqual(readdirSync(dir).sort(), before);
    }

    MarfaCore.removeStore(path, shown.confirmation);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);
    assert.equal(existsSync(`${path}.blobs`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store whose write changed under the same id after it was shown is not removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-remove-"));
  try {
    const path = join(dir, "copy.sqlite");
    storeWithOneUnsent(path);
    const db = new DatabaseSync(path);
    db.exec(`UPDATE queue SET payload = '{"properties":{"title":"shown"}}' WHERE id = 'q1'`);
    const shown = MarfaCore.readUnsent(path);
    db.exec(`UPDATE queue SET payload = '{"properties":{"title":"changed"}}' WHERE id = 'q1'`);
    db.close();
    const before = readdirSync(dir).sort();

    const differs = refusal(() => MarfaCore.removeStore(path, shown.confirmation));
    assert.equal(differs.code, "unsent_differs");
    assert.equal(differs.unsent, 1);
    assert.deepEqual(readdirSync(dir).sort(), before);
    const now = MarfaCore.readUnsent(path);
    assert.deepEqual(
      now.writes.map((write) => [write.id, write.body]),
      [["q1", '{"properties":{"title":"changed"}}']],
    );

    MarfaCore.removeStore(path, now.confirmation);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
