// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore, linkParts } from "../index.js";

test("a link's parts are placed as a JavaScript string counts them", () => {
  const text = "\u{1F600} [[Plan#Goals|the plan]] and `[[code]]`";
  const [link, ...rest] = linkParts(text);
  assert.deepEqual(rest, []);
  assert.equal(text.slice(link.start, link.end), "[[Plan#Goals|the plan]]");
  assert.equal(link.target, "Plan#Goals|the plan");
  for (const part of [link.name, link.heading, link.alias]) {
    assert.ok(part);
    assert.equal(text.slice(part.start, part.end), part.text);
  }
  assert.deepEqual(
    [link.name.text, link.heading?.text, link.alias?.text],
    ["Plan", "Goals", "the plan"],
  );
});

test("a link's candidates are every item it could name, from the copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-links-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    /** @param {string} title */
    const note = (title) =>
      core.createItem({ type: "core.note", properties: { title } }).itemId ?? "";
    const both = [note("Plan"), note("PLAN")].sort();
    const [plan, byId, cafe] = core.linkCandidates(null, ["plan", both[0], "Café"]);
    assert.equal(plan.state, "ambiguous");
    assert.deepEqual([...plan.candidates].sort(), both);
    assert.equal(byId.state, "bound");
    assert.equal(byId.item, both[0]);
    assert.equal(cafe.state, "unresolved");
    assert.deepEqual(cafe.candidates, []);
    assert.throws(
      () => core.linkCandidates("00000000-0000-4000-8000-000000000000", []),
      /item_not_found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
