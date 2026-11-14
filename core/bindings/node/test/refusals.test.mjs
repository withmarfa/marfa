// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ItemState, MarfaCore } from "../index.js";

test("refuses a move to the revoked state as a value that breaks a rule, naming no server", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-refusals-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    const held = core.createItem({ type: "core.note", properties: { title: "held" } });
    const id = held.itemId ?? "";
    const queued = core.queue().length;
    assert.throws(
      () => core.transitionItem(id, ItemState.Revoked),
      (/** @type {any} */ error) => {
        assert.equal(error.code, "validation");
        assert.equal(error.local.code, "validation_error");
        assert.equal(error.server, undefined);
        return true;
      },
    );
    assert.equal(core.queue().length, queued);
    // The witness: a state a device may name is queued.
    core.transitionItem(id, ItemState.Archived);
    assert.equal(core.queue().length, queued + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
