// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBudgetKind, MarfaCore } from "../index.js";

/** @param {(path: string) => void} body */
function inStore(body) {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-file-cache-"));
  try {
    body(join(dir, "copy.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the file budget is set, read, kept and trimmed through the module", () => {
  inStore((path) => {
    const core = MarfaCore.open(path);
    assert.equal(core.fileCache().setting.kind, FileBudgetKind.Default);
    assert.equal(core.status().fileCache.held, 0);

    assert.equal(core.fileCache().backupMarkFailure, undefined);

    // Nothing is held, so setting the budget takes nothing.
    assert.equal(
      core.setFileBudget({ kind: FileBudgetKind.Bytes, bytes: 100 }),
      0,
    );
    const set = core.fileCache();
    assert.deepEqual(set.setting, { kind: FileBudgetKind.Bytes, bytes: 100 });
    assert.equal(set.budget, 100);
    assert.equal(core.trimFiles(), 0);

    core.setFileBudget({ kind: FileBudgetKind.KeepAll });
    assert.equal(core.fileCache().budget, undefined);

    // A reading handle sees the setting and cannot change it.
    const reader = MarfaCore.openReader(path);
    assert.equal(reader.fileCache().setting.kind, FileBudgetKind.KeepAll);
    assert.throws(() => reader.trimFiles(), { code: "reading_handle" });
    assert.throws(
      () => reader.setFileBudget({ kind: FileBudgetKind.Default }),
      { code: "reading_handle" },
    );
  });
});

test("a budget that names bytes needs a whole count, and no other kind takes one", () => {
  inStore((path) => {
    const core = MarfaCore.open(path);
    const kept = { kind: FileBudgetKind.Bytes, bytes: 100 };
    core.setFileBudget(kept);
    for (const budget of [
      { kind: FileBudgetKind.Bytes },
      { kind: FileBudgetKind.Bytes, bytes: -1 },
      { kind: FileBudgetKind.Bytes, bytes: 1.5 },
      { kind: FileBudgetKind.Bytes, bytes: -0.5 },
      { kind: FileBudgetKind.Bytes, bytes: Number.NaN },
      { kind: FileBudgetKind.Bytes, bytes: Number.POSITIVE_INFINITY },
      { kind: FileBudgetKind.Bytes, bytes: Number.NEGATIVE_INFINITY },
      { kind: FileBudgetKind.Bytes, bytes: Number.MAX_SAFE_INTEGER + 1 },
      { kind: FileBudgetKind.Default, bytes: 1 },
      { kind: FileBudgetKind.KeepAll, bytes: 1 },
    ]) {
      assert.throws(
        () => core.setFileBudget(budget),
        { code: "invalid" },
        `${String(budget.bytes)} was taken`,
      );
      assert.deepEqual(core.fileCache().setting, kept);
    }

    // The witness: the largest whole count JavaScript holds exactly is taken.
    const largest = { kind: FileBudgetKind.Bytes, bytes: Number.MAX_SAFE_INTEGER };
    core.setFileBudget(largest);
    assert.deepEqual(core.fileCache().setting, largest);
  });
});
