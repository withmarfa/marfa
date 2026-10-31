// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore } from "../index.js";

const TARGET = "01900000-0000-7000-8000-000000000002";

/** @param {import("node:test").TestContext} t */
function openCopy(t) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-node-fields-"));
  const core = MarfaCore.open(
    join(directory, "copy.sqlite"),
    "http://127.0.0.1:1",
    "k",
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return core;
}

test("queues a create with a state, a capture location and edges as one write", (t) => {
  const core = openCopy(t);
  const before = core.queue().length;
  const made = core.createItem({
    type: "core.note",
    properties: { body: "kept" },
    state: "archived",
    captureLatitude: -33.9,
    captureLongitude: 151.2,
    edges: { references: [TARGET] },
  });
  assert.equal(core.queue().length, before + 1);
  const held = core.get(/** @type {string} */ (made.itemId));
  assert.equal(held?.state, "archived");
  assert.equal(held?.captureLatitude, -33.9);
  assert.equal(held?.captureLongitude, 151.2);

  // The witness above: each refusal below is the same create with one field
  // the server would refuse, and none queues anything.
  for (const bad of [
    { state: "revoked" },
    { captureLatitude: Number.NaN, captureLongitude: 0 },
    { edges: { references: ["not-an-id"] } },
  ]) {
    assert.throws(() =>
      core.createItem(/** @type {any} */ ({ type: "core.note", properties: {}, ...bad })),
    );
  }
  assert.equal(core.queue().length, before + 1);
});

test("lists by source and change time, and sorts by a property", (t) => {
  const core = openCopy(t);
  for (const [n, source] of [[1, "a"], [2, "b"], [3, "a"]]) {
    core.createItem({
      type: "core.note",
      properties: { body: "x", rank: n === 2 ? undefined : n },
      source: /** @type {string} */ (source),
      sourceId: `s${n}`,
    });
  }
  assert.equal(core.list({ source: "a" }).items.length, 2);
  assert.equal(
    core.list({ updatedAfter: "2999-01-01T00:00:00.000Z" }).items.length,
    0,
  );
  assert.equal(
    core.list({ updatedBefore: "2999-01-01T00:00:00.000Z" }).items.length,
    3,
  );
  const sorted = core.list(
    { source: "a" },
    { field: "properties.rank", direction: /** @type {any} */ ("desc") },
  );
  assert.deepEqual(
    sorted.items.map((row) => row.properties.rank),
    [3, 1],
  );
  assert.throws(() =>
    core.list({}, { field: /** @type {any} */ ("properties.a;b"), direction: /** @type {any} */ ("asc") }),
  );
  // Beside updatedAfter, either half of its own order is taken alone and a
  // half naming another is refused, as the server answers.
  const after = { updatedAfter: "2000-01-01T00:00:00.000Z" };
  assert.equal(core.list(after, { field: "updated_at" }).items.length, 3);
  assert.equal(
    core.list(after, { direction: /** @type {any} */ ("asc") }).items.length,
    3,
  );
  assert.throws(() => core.list(after, { field: "created_at" }));
  assert.throws(() =>
    core.list(after, { direction: /** @type {any} */ ("desc") }),
  );
});

test("sets and clears an item's own time through an edit", (t) => {
  const core = openCopy(t);
  const made = core.createItem({ type: "core.note", properties: { body: "x" } });
  const id = /** @type {string} */ (made.itemId);
  const version = core.get(id)?.version ?? 0;
  core.updateItem(id, {
    properties: {},
    baseVersion: version,
    occurredAt: "2025-06-01T12:00:00.000Z",
  });
  assert.equal(core.get(id)?.occurredAt, "2025-06-01T12:00:00.000Z");
  core.updateItem(id, {
    properties: {},
    baseVersion: version,
    clearOccurredAt: true,
  });
  assert.equal(core.get(id)?.occurredAt, core.get(id)?.createdAt);
  assert.throws(() =>
    core.updateItem(id, {
      properties: {},
      baseVersion: version,
      occurredAt: "2025-06-01T12:00:00.000Z",
      clearOccurredAt: true,
    }),
  );
});

test("removes the properties an edit clears and keeps every other", (t) => {
  const core = openCopy(t);
  const made = core.createItem({
    type: "core.note",
    properties: { body: "kept", notes: "gone", courier: { nested: [1] } },
  });
  const id = /** @type {string} */ (made.itemId);
  const version = core.get(id)?.version ?? 0;
  assert.throws(() =>
    core.updateItem(id, {
      properties: { notes: "both" },
      baseVersion: version,
      clearProperties: ["notes"],
    }),
  );
  assert.equal(core.get(id)?.properties.notes, "gone");
  const queued = core.updateItem(id, {
    properties: {},
    baseVersion: version,
    clearProperties: ["notes", "never-held"],
  });
  assert.deepEqual(core.get(id)?.properties, {
    body: "kept",
    courier: { nested: [1] },
  });
  const sent = core.queue().find((row) => row.id === queued.id);
  assert.deepEqual(
    /** @type {Record<string, unknown>} */ (sent?.body).clear_properties,
    ["notes", "never-held"],
  );
});
