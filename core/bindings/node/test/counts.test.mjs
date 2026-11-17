// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore } from "../index.js";

const ONE = "01a1011a-4902-76cf-a4a9-88e99c038c8d";

test("a count of links is refused invalid where the copy holds no edge type whole, and a request must name one thing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-counts-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    await assert.rejects(
      core.counts([ONE], { backref: "parent-of" }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, "invalid");
        assert.equal(error.server, undefined);
        return true;
      },
    );
    await assert.rejects(
      core.counts([ONE], { backref: "parent-of", table: "messages" }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, "validation");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
