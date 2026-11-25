// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Folders } from "../index.js";

test("lists the store each registry entry holds, and none where it holds none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-folders-"));
  const registry = process.env.MARFA_FOLDER_REGISTRY;
  t.after(() => {
    if (registry === undefined) delete process.env.MARFA_FOLDER_REGISTRY;
    else process.env.MARFA_FOLDER_REGISTRY = registry;
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "folders.json");
  writeFileSync(
    file,
    JSON.stringify({
      folders: [
        { dir: join(dir, "first"), folder: "folder-a", store: "0192-first-store" },
        { dir: join(dir, "second"), folder: "folder-a", store: "0192-second-store" },
        { dir: join(dir, "bare"), folder: "folder-b" },
      ],
    }),
  );
  process.env.MARFA_FOLDER_REGISTRY = file;

  const listed = await new Folders().list();
  const storeOf = (/** @type {string} */ name) =>
    listed.find((entry) => entry.dir === join(dir, name))?.store;
  assert.equal(listed.length, 3);
  assert.equal(storeOf("first"), "0192-first-store");
  assert.equal(storeOf("second"), "0192-second-store");
  // The witness: an entry with none lists none, not an empty text.
  assert.equal(storeOf("bare"), undefined);
});
