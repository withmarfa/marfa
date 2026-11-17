// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore, SliceTier } from "../index.js";
import { AT, CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

/** @param {string} id */
function steps(id) {
  return {
    id,
    type: "test.steps",
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

/** @param {string} id @param {number} cursor */
function arrival(id, cursor) {
  const data = JSON.stringify({
    event_type: "item.created",
    listed: true,
    item: steps(id),
    metadata: { tags: [] },
  });
  return `id: ${cursor}\nevent: item.created\ndata: ${data}\n\n`;
}

async function scripted() {
  let arrives = false;
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (/** @type {unknown} */ body) => {
      res.writeHead(200, {
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
        data: [
          {
            id: "test.steps",
            fields: { title: { type: "string" } },
            tables: { steps: { columns: { count: { type: "integer" } } } },
          },
        ],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json({ data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      json({
        data: [{ listed: true, item: steps("held"), metadata: { tags: [] } }],
        next_cursor: null,
      });
    } else if (path.endsWith("/tables")) {
      json({ data: [{ name: "steps", row_count: 0, bytes: 0 }] });
    } else if (path.endsWith("/tables/steps/rows")) {
      json({ data: [], next_cursor: null });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor !== null) {
        if (arrives && cursor === "10") res.write(arrival("arrived", 11));
        res.write(marker("stream_live", arrives && cursor === "10" ? "11" : cursor));
      }
      res.end();
    } else {
      res.writeHead(404, { "x-marfa-contract": CONTRACT });
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    arrive: () => {
      arrives = true;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("names the table a catch-up filled, though no row of it was written", async (t) => {
  const server = await scripted();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["test.steps"], SliceTier.Library);
  const hold = await core.holdTable("test.steps", "steps");
  assert.equal(hold.fill?.whole, 1, "the hold did not fill the table it held");

  const quiet = await core.catchUp();
  assert.deepEqual(
    [quiet.tables.whole, quiet.changedTables],
    [0, []],
    "a catch-up that changed no table named one",
  );

  server.arrive();
  const caught = await core.catchUp();
  assert.equal(
    caught.tables.whole,
    1,
    "the catch-up did not fill the table of the item that arrived, so the test proves nothing",
  );
  assert.deepEqual(
    caught.changedTables,
    [{ item: "arrived", table: "steps" }],
    "the binding dropped the table the catch-up filled",
  );
});
