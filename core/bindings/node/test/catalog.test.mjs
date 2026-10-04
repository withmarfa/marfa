// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EdgeEnd, MarfaCore, Tier } from "../index.js";
import { CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

const RECIPE = {
  id: "acme.recipe",
  parent: "core.note",
  label: "Family recipe",
  version: 0,
  fields: { servings: { type: "number", required: true } },
};

const MENTOR = {
  id: "mentor-of",
  cardinality: "one-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  property_schema: {},
  reverse_name: "mentored-by",
  written_at: "target",
  shipped: false,
};

async function scripted() {
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
            id: "core.note",
            fields: { title: { type: "string" } },
            display_hints: { title_field: "title" },
          },
          RECIPE,
        ],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json({ data: [MENTOR], next_cursor: null });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      json({ data: [], next_cursor: null });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      res.end();
    } else {
      res.writeHead(404);
      res.end();
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

test("holds the types Marfa ships before a server's catalog is read, then reads that offline", async (t) => {
  const server = await scripted();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "core.sqlite");

  const core = MarfaCore.open(path, server.url, "k");
  assert.equal(core.status().catalogVersion, undefined);
  assert.ok(core.itemTypes().some((held) => held.id === "core.note"));
  assert.throws(() => core.itemType("acme.recipe"), /^Error: not_found: /);
  assert.throws(() => core.edgeType("mentor-of"), /^Error: not_found: /);

  await core.hydrate(["core.note"], Tier.Library);
  assert.equal(typeof core.status().catalogVersion, "number");
  server.close();

  const recipe = core.itemType("acme.recipe");
  assert.equal(recipe.label, "Family recipe");
  assert.deepEqual(
    recipe.fields.map((field) => [field.name, field.type, field.declaredBy]),
    [
      ["servings", "number", "acme.recipe"],
      ["title", "string", "core.note"],
    ],
  );
  assert.equal(recipe.titleField, "title");
  assert.deepEqual(recipe.fields[0]?.definition, RECIPE.fields.servings);
  const mentor = core.edgeType("mentor-of");
  assert.equal(mentor.reverseName, "mentored-by");
  assert.equal(mentor.writtenAt, EdgeEnd.Target);
  assert.deepEqual(
    core.edgeTypes().map((type) => type.id),
    ["mentor-of"],
  );
  assert.throws(() => core.createItem({ type: "acme.absent", properties: {} }), /^Error: unknown_type: acme\.absent is not a type this copy holds$/);
  assert.throws(() => core.createItem({ type: "acme.recipe", properties: {} }), /^Error: validation: \(invalid_properties\) servings: Required field is missing$/);
  assert.equal(core.queue().length, 0);
  assert.throws(() => core.itemType("acme.absent"), /^Error: not_found: .*acme\.absent/);
});
