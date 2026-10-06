// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore, Tier } from "../index.js";
import { CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

const AT = "2026-01-01T00:00:00Z";

/** @param {string} id @param {string} target */
function derivedFrom(id, target) {
  return {
    id: `${id}-link`,
    source_id: id,
    target_id: target,
    edge_type: "derived-from",
    properties: {},
    version: 1,
    created_at: AT,
    updated_at: AT,
  };
}

/** @param {string} id @param {string[]} tags */
function row(id, tags) {
  return {
    listed: true,
    item: {
      id,
      type: "core.note",
      properties: { title: id },
      state: "active",
      tier: "library",
      version: 1,
      schema_version: 1,
      source: "test",
      occurred_at: AT,
      created_at: AT,
      updated_at: AT,
      edges: {
        "derived-from": { data: [derivedFrom(id, "original")], next_cursor: null },
      },
    },
    metadata: { tags },
  };
}

async function scripted() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (/** @type {unknown} */ body, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
        ...readProof(req),
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      json({ instance_id: INSTANCE });
    } else if (path === "/types") {
      json({
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json({ data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      // The original is not in the slice. A row made from it and not tagged
      // a conflicted copy is the witness that the tag is asked.
      json({
        data: [row("copy", ["conflicted-copy"]), row("promoted", [])],
        next_cursor: null,
      });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      res.end();
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

test("answers a conflicted copy's original, and the copies made from an item", async (t) => {
  const server = await scripted();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);

  assert.equal(core.get("original"), null);
  assert.deepEqual(
    core.edgesTo("original").map((edge) => edge.sourceId),
    ["copy", "promoted"],
  );
  assert.equal(core.originalOfConflictedCopy("copy"), "original");
  assert.equal(core.originalOfConflictedCopy("promoted"), null);
  assert.equal(core.originalOfConflictedCopy("unheld"), null);
  assert.deepEqual(
    core.conflictedCopiesOf("original").map((item) => item.id),
    ["copy"],
  );
});
