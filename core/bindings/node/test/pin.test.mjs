// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore, Tier } from "../index.js";

const CONTRACT = /** @type {{ info: { version: string } }} */ (
  JSON.parse(readFileSync(new URL("../../../../openapi.json", import.meta.url), "utf8"))
).info.version;

const AT = "2026-01-01T00:00:00Z";

/** @param {string} id @param {string} type */
function item(id, type) {
  return {
    id,
    type,
    properties: { title: id },
    state: "active",
    tier: "library",
    version: 1,
    schema_version: 1,
    source: "test",
    occurred_at: AT,
    created_at: AT,
    updated_at: AT,
  };
}

/** @param {string} id @param {string} source @param {string} target */
function parentOf(id, source, target) {
  return {
    id,
    source_id: source,
    target_id: target,
    edge_type: "parent-of",
    properties: {},
    version: 1,
    created_at: AT,
    updated_at: AT,
  };
}

async function scripted() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (/** @type {unknown} */ body, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/types") {
      json({
        data: [
          { id: "core.note", display_hints: { title_field: "title" } },
          { id: "core.bookmark", display_hints: { title_field: "title" } },
        ],
        next_cursor: null,
      });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      json({
        data: [{ item: item("note", "core.note"), metadata: { tags: [] } }],
        next_cursor: null,
      });
    } else if (path === "/items/settings") {
      json({ item: item("settings", "core.bookmark"), metadata: { tags: [] } });
    } else if (path === "/edges") {
      json({ data: [parentOf("beneath", "outer", "inner")], next_cursor: null });
    } else if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        ': connected\n\nevent: stream_cursor\ndata: {"type":"stream_cursor","cursor":"10"}\n\n',
      );
    } else {
      json({ error: { code: "not_found", message: "no such item" } }, 404);
    }
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** @param {import("node:test").TestContext} t */
async function opened(t) {
  const server = await scripted();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
}

test("holds an edge type whole and reports it", async (t) => {
  const core = await opened(t);
  const report = await core.hydrateWith(["core.note"], Tier.Library, [
    "parent-of",
  ]);
  assert.deepEqual(report.edgeTypes, ["parent-of"]);
  assert.deepEqual(core.status().sliceEdgeTypes, ["parent-of"]);
  assert.deepEqual(
    core.edgesFrom("outer").map((edge) => edge.id),
    ["beneath"],
  );

  await core.hydrate(["core.note"], Tier.Library);
  assert.deepEqual(core.status().sliceEdgeTypes, []);
  assert.deepEqual(core.edgesFrom("outer"), []);
});

test("reads every edge of one type the copy holds in one call", async (t) => {
  const core = await opened(t);
  await core.hydrateWith(["core.note"], Tier.Library, ["parent-of"]);
  core.createEdge({
    sourceId: "note",
    targetId: "inner",
    edgeType: "parent-of",
    properties: {},
  });
  assert.deepEqual(
    core
      .edgesOfType("parent-of")
      .map((edge) => [edge.id === "beneath", edge.sourceId]),
    [
      [true, "outer"],
      [false, "note"],
    ],
  );
  assert.deepEqual(core.edgesOfType("references"), []);
});

test("pins and unpins a row outside the slice, saying whether it was pinned", async (t) => {
  const core = await opened(t);
  await core.hydrate(["core.note"], Tier.Library);
  assert.equal(core.get("settings"), null);

  assert.deepEqual(await core.pin("settings"), {
    pinned: true,
    wasPinned: false,
  });
  assert.equal(core.get("settings")?.type, "core.bookmark");
  assert.deepEqual(core.status().pinned, ["settings"]);
  assert.deepEqual(await core.pin("settings"), {
    pinned: true,
    wasPinned: true,
  });

  assert.deepEqual(core.unpin("settings"), { pinned: false, wasPinned: true });
  assert.equal(core.get("settings"), null);
  assert.deepEqual(core.status().pinned, []);
  assert.deepEqual(core.unpin("settings"), { pinned: false, wasPinned: false });
});

test("refuses a pin of a row neither the server nor the copy holds", async (t) => {
  const core = await opened(t);
  await core.hydrate(["core.note"], Tier.Library);
  await assert.rejects(core.pin("absent"), /no item absent/);
  assert.deepEqual(core.status().pinned, []);
});
