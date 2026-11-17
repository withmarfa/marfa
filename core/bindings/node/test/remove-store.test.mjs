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
    return /** @type {{ code?: string, unsent?: string[] | null, agreed?: string[] }} */ (
      error
    );
  }
  assert.fail("the call was not refused");
}

test("a store is removed only with the ids of the unsent writes it holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-remove-"));
  try {
    const path = join(dir, "copy.sqlite");
    storeWithOneUnsent(path);
    writeFileSync(join(dir, "notes.txt"), "kept");
    const before = readdirSync(dir).sort();
    const shown = MarfaCore.readUnsent(path).map((write) => write.id);
    assert.deepEqual(shown, ["q1"]);

    for (const agreed of [[], ["q2"], ["q1", "q2"]]) {
      const differs = refusal(() => MarfaCore.removeStore(path, agreed));
      assert.equal(differs.code, "unsent_differs");
      assert.deepEqual(differs.unsent, ["q1"]);
      assert.deepEqual(differs.agreed, agreed);
      assert.deepEqual(readdirSync(dir).sort(), before);
    }

    MarfaCore.removeStore(path, shown);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);
    assert.equal(existsSync(`${path}.blobs`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
