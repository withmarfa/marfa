// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EdgeEnd, MarfaCore, SliceTier } from "../index.js";
import { CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

const RECIPE = {
  id: "acme.recipe",
  parent: "core.note",
  label: "Family recipe",
  version: 0,
  fields: { servings: { type: "number", required: true } },
};

const LATE = { id: "acme.late", parent: "core.note", version: 0, fields: {} };

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

/**
 * @param {{ registered?: () => boolean, streamFails?: () => boolean }} [options]
 *   `registered` adds a type to the catalog; `streamFails` answers a
 *   catch-up's stream 500.
 */
async function scripted(options = {}) {
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
          ...(options.registered?.() ? [LATE] : []),
        ],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json({ data: [MENTOR], next_cursor: null });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      json({ data: [], next_cursor: null });
    } else if (
      path === "/events" &&
      req.headers["last-event-id"] !== undefined &&
      options.streamFails?.()
    ) {
      res.writeHead(500, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        JSON.stringify({
          error: { code: "internal_error", message: "scripted" },
        }),
      );
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

  await core.hydrate(["core.note"], SliceTier.Library);
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
  // The error carries the core's name for it and the server's own code beside
  // it, as properties, so a caller need not read them out of the message.
  assert.throws(
    () => core.itemType("acme.absent"),
    (/** @type {any} */ error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.code, "not_found");
      assert.equal(error.serverCode, "type_not_found");
      return true;
    },
  );
  assert.throws(
    () => core.createItem({ type: "acme.absent", properties: {} }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, "unknown_type");
      assert.equal(error.serverCode, "unknown_type");
      return true;
    },
  );
});

test("says whether a catch-up changed the catalog, and says it of one that then failed", async (t) => {
  let registered = false;
  let streamFails = false;
  const server = await scripted({
    registered: () => registered,
    streamFails: () => streamFails,
  });
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], SliceTier.Library);

  assert.equal((await core.catchUp()).catalogChanged, false);
  registered = true;
  assert.equal(
    (await core.catchUp()).catalogChanged,
    true,
    "a catch-up that changed the catalog did not say so",
  );

  streamFails = true;
  /** @param {boolean} changed */
  const failsSaying = (changed) => (/** @type {any} */ error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, "server");
    assert.equal(error.catalogChanged, changed);
    return true;
  };
  // The witness: the same failure against the catalog the copy holds.
  await assert.rejects(core.catchUp(), failsSaying(false));
  registered = false;
  await assert.rejects(
    core.catchUp(),
    failsSaying(true),
    "a catch-up that changed the catalog and then failed did not say the catalog changed",
  );
  assert.throws(() => core.itemType("acme.late"), /^Error: not_found: /);
});
