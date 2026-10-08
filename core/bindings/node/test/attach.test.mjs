// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore } from "../index.js";

test("an attach answers the text that embeds the file in the item's body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-attach-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    const host = core.createItem({
      type: "core.note",
      properties: { title: "Host", body: "" },
    });
    const file = join(dir, "photo.png");
    writeFileSync(file, "a photo");
    const first = await core.attach(host.itemId ?? "", file);
    const second = await core.attach(host.itemId ?? "", file);
    assert.deepEqual(
      [first.embed, second.embed],
      ["![[photo.png]]", "![[photo 2.png]]"],
    );
    assert.deepEqual(
      [first.upload.kind, first.item.kind, first.edge.kind],
      ["upload_blob", "create_item", "create_edge"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
