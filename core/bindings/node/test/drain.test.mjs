// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore, SliceTier, BlockedReason, GrantKind, GrantLevel } from "../index.js";
import { CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

async function unclaiming(missingGrant = false) {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
        ...readProof(req),
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      json(200, { instance_id: INSTANCE });
    } else if (path === "/types") {
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
          details: missingGrant
            ? { grant: { kind: "type", name: "core.note", level: "write" } }
            : { source: "notes" },
        },
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      res.end();
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
  await core.hydrate(["core.note"], SliceTier.Library);
  core.createItem({
    type: "core.note",
    properties: { title: "a" },
    source: "notes",
    sourceId: "a.md",
    baseVersion: 0,
  });
  const report = await core.drain();
  assert.equal(report.answered, 1);
  assert.deepEqual(report.unclaimedSources, ["notes"]);
});

/** A server that takes every create, slowly, and counts the creates sent. */
async function slowlyTaking() {
  const sent = { creates: 0 };
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
        ...readProof(req),
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      json(200, { instance_id: INSTANCE });
    } else if (path === "/types") {
      json(200, {
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json(200, { type_permissions: { "*": "write" } });
    } else if (path === "/items" && req.method === "POST") {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        sent.creates += 1;
        const body = JSON.parse(text);
        const at = "2026-01-01T00:00:00.000Z";
        const item = {
          id: body.id,
          type: body.type,
          properties: body.properties,
          state: "active",
          tier: body.tier,
          version: 1,
          schema_version: 1,
          source: "device",
          source_id: null,
          occurred_at: at,
          created_at: at,
          updated_at: at,
        };
        rows.set(body.id, item);
        setTimeout(() => json(201, { item }), 20);
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path.startsWith("/items/")) {
      const item = rows.get(decodeURIComponent(path.slice("/items/".length)));
      if (item) json(200, { item, metadata: { tags: [] }, listed: true });
      else json(404, { error: { code: "item_not_found", message: "no such item" } });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      res.end();
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
    sent,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("sends each write once however many drains run at once", async (t) => {
  const server = await slowlyTaking();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], SliceTier.Library);
  for (let n = 0; n < 6; n += 1) {
    core.createItem({ type: "core.note", properties: { title: `note ${n}` } });
  }
  const reports = await Promise.all([core.drain(), core.drain(), core.drain()]);
  assert.equal(
    server.sent.creates,
    6,
    "drains run at once sent the same writes more than once",
  );
  assert.equal(
    reports.reduce((sum, report) => sum + report.answered, 0),
    6,
    "the drains counted writes they did not have answered",
  );
  assert.equal(
    core.list({ type: "core.note" }).length,
    6,
    "the fresh reads did not reconcile every accepted create into the copy",
  );
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
        ...readProof(req),
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      json(200, { instance_id: INSTANCE });
    } else if (path === "/types") {
      json(200, {
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json(200, { data: [], next_cursor: null });
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
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      res.end();
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
  await core.hydrate(["core.note"], SliceTier.Library);
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


test("reports a missing grant in both the drain and queued blocked verdict", async (t) => {
  const server = await unclaiming(true);
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], SliceTier.Library);
  core.createItem({ type: "core.note", properties: { title: "kept" } });
  const report = await core.drain();
  const queued = core.queue();
  for (const verdict of [report.verdicts[0]?.verdict, queued[0]?.verdict]) {
    assert.equal(verdict?.verdict, "blocked");
    if (verdict?.verdict !== "blocked") throw new Error("expected a blocked verdict");
    assert.equal(verdict.reason, BlockedReason.CredentialRefused);
    assert.equal(verdict.refusal?.code, "forbidden");
    assert.deepEqual(verdict.refusal?.grant, { kind: GrantKind.Type, name: "core.note", level: GrantLevel.Write });
  }
  assert.equal(queued[0]?.waiting, false);
  assert.deepEqual(queued[0]?.body, { type: "core.note", properties: { title: "kept" }, tier: "library", id: queued[0]?.itemId });
});
