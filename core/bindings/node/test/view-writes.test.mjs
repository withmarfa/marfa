// @ts-check
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MarfaCore } from "../index.js";
import { AT, CONTRACT, storeFor } from "./copy-fixture.mjs";

const settings = {
  title: "Notes",
  query: { types: ["core.note"] },
  layouts: [{ id: "list", kind: "list" }],
};

test("view writes preserve settings, versions, keys, and structured refusals across Node", async (t) => {
  /** @type {Array<{method: string | undefined, path: string | undefined, key: string | string[] | undefined, body: unknown}>} */
  const sent = [];
  let status = 201;
  let code = "";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    sent.push({
      method: req.method,
      path: req.url,
      key: req.headers["idempotency-key"],
      body: text ? JSON.parse(text) : null,
    });
    res.writeHead(status, {
      "content-type": "application/json",
      "x-marfa-contract": CONTRACT,
    });
    if (status >= 400) {
      res.end(
        JSON.stringify({
          error: { code, message: "Refused by the view door" },
        }),
      );
    } else if (req.method === "DELETE") {
      res.end();
    } else {
      res.end(
        JSON.stringify({
          item: {
            id: "view",
            type: "system.view",
            state: "active",
            tier: "library",
            version: req.method === "PATCH" ? 2 : 1,
            schema_version: 1,
            source: "test",
            occurred_at: AT,
            created_at: AT,
            updated_at: AT,
            properties:
              req.method === "PATCH"
                ? { ...settings, title: "Changed" }
                : settings,
          },
          metadata: { tags: [] },
        }),
      );
    }
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const core = MarfaCore.open(
    storeFor(t),
    `http://127.0.0.1:${address.port}`,
    "k",
  );
  const made = await core.createView(settings, "create-view");
  assert.deepEqual(made, { id: "view", version: 1, state: "active", settings });
  const changes = { title: "Changed" };
  status = 200;
  const pending = core.changeView(
    made.id,
    changes,
    made.version,
    "change-view",
  );
  changes.title = "Changed after sending";
  const changed = await pending;
  assert.equal(changed.version, 2);
  assert.deepEqual(changed.settings, { ...settings, title: "Changed" });
  status = 204;
  await core.deleteView(made.id, "delete-view");
  assert.deepEqual(sent, [
    { method: "POST", path: "/views", key: "create-view", body: settings },
    {
      method: "PATCH",
      path: "/views/view",
      key: "change-view",
      body: { title: "Changed", version: 1 },
    },
    { method: "DELETE", path: "/views/view", key: "delete-view", body: null },
  ]);
  for (const [httpStatus, serverCode, classification] of [
    [409, "version_conflict", "server"],
    [400, "invalid_transition", "validation"],
    [400, "invalid_query", "validation"],
    [403, "type_not_permitted", "forbidden"],
    [404, "not_found", "not_found"],
  ]) {
    status = Number(httpStatus);
    code = String(serverCode);
    await assert.rejects(
      core.changeView("view", { title: "Refused" }, 1),
      (error) => {
        const refusal = /** @type {{code:string, serverCode:string}} */ (error);
        assert.equal(refusal.code, classification);
        assert.equal(refusal.serverCode, serverCode);
        return true;
      },
    );
  }
});

test("offline view writes reject with no_server and preserve the existing queue", async (t) => {
  const core = MarfaCore.open(storeFor(t));
  core.createItem({
    type: "core.note",
    properties: { title: "Queued witness", body: "" },
  });
  const queued = core.queue();
  assert.equal(queued.length, 1);
  for (const call of [
    () => core.createView(settings),
    () => core.changeView("view", { title: "Changed" }, 1),
    () => core.deleteView("view"),
  ]) {
    await assert.rejects(call(), (error) => {
      assert.equal(/** @type {{code:string}} */ (error).code, "no_server");
      return true;
    });
    assert.deepEqual(core.queue(), queued);
  }
});
