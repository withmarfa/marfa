// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EdgeEnd, MarfaCore, Tier } from "../index.js";

const CONTRACT = /** @type {{ info: { version: string } }} */ (
  JSON.parse(readFileSync(new URL("../../../../openapi.json", import.meta.url), "utf8"))
).info.version;

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
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      json({ instance_id: "00000000-0000-7000-8000-000000000000" });
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
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        ': connected\n\nevent: stream_cursor\ndata: {"type":"stream_cursor","cursor":"10"}\n\n',
      );
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

test("refuses a catalog read before a catalog is held, then reads it offline", async (t) => {
  const server = await scripted();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "core.sqlite");

  const core = MarfaCore.open(path, server.url, "k");
  assert.equal(core.status().catalogVersion, undefined);
  assert.throws(() => core.itemTypes(), /^Error: no_catalog: /);
  assert.throws(() => core.edgeType("mentor-of"), /^Error: no_catalog: /);

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
  assert.throws(() => core.itemType("acme.absent"), /^Error: not_found: .*acme\.absent/);
});
