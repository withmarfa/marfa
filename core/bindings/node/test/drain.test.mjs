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

async function unclaiming() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/types") {
      json(200, {
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json(200, { type_permissions: { "*": "write" } });
    } else if (path === "/items" && req.method === "POST") {
      json(403, {
        error: {
          code: "forbidden",
          message: "not claimed",
          details: { source: "notes" },
        },
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        ': connected\n\nevent: stream_cursor\ndata: {"type":"stream_cursor","cursor":"10"}\n\n',
      );
    } else {
      res.writeHead(404).end();
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

test("names a source its key does not claim", async (t) => {
  const server = await unclaiming();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  core.createItem({
    type: "core.note",
    properties: { title: "a" },
    source: "notes",
    sourceId: "a.md",
    baseVersion: 0,
  });
  const report = await core.drain();
  assert.equal(report.sent, 1);
  assert.deepEqual(report.unclaimedSources, ["notes"]);
});

/** A server that refuses every create, naming the field it would not take. */
async function refusing() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/types") {
      json(200, {
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/keys/current") {
      json(200, { type_permissions: { "*": "write" } });
    } else if (path === "/items" && req.method === "POST") {
      json(400, {
        error: {
          code: "invalid_properties",
          message: "Invalid properties",
          details: { errors: [{ field: "title", message: "Too long" }] },
        },
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path.startsWith("/items/")) {
      json(404, { error: { code: "item_not_found", message: "not found" } });
    } else if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        ': connected\n\nevent: stream_cursor\ndata: {"type":"stream_cursor","cursor":"10"}\n\n',
      );
    } else {
      res.writeHead(404).end();
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

test("reads a refusal into its parts, and keeps the refused body until it is discarded", async (t) => {
  const server = await refusing();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  const created = core.createItem({
    type: "core.note",
    properties: { title: "the words a person wrote" },
  });
  const report = await core.drain();
  const verdict = report.verdicts[0]?.verdict;
  assert.equal(verdict?.verdict, "refused");
  if (verdict?.verdict !== "refused") return;
  assert.equal(verdict.refusal.code, "invalid_properties");
  assert.deepEqual(verdict.refusal.fields, [
    { field: "title", message: "Too long" },
  ]);
  assert.equal(verdict.refusal.trashed, false);

  assert.equal(core.forgetAnswered(), 0);
  const kept = core.queue();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.waiting, false);
  assert.deepEqual(
    /** @type {{ properties: unknown }} */ (kept[0]?.body).properties,
    { title: "the words a person wrote" },
  );
  assert.equal(core.discard(created.id), true);
  assert.deepEqual(core.queue(), []);
});
