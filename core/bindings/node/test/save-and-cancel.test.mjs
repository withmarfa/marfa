// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Handle, Hydration, MarfaCore, Stop, Tier } from "../index.js";
import {
  CONTRACT,
  INSTANCE,
  marker,
  readProof,
  streamHead,
} from "./copy-fixture.mjs";

/** @typedef {import("node:http").ServerResponse} Response */

/**
 * @param {{ slowPages?: boolean; slowWrites?: boolean }} [options]
 */
async function serving(options = {}) {
  let hold = false;
  /** @type {string[]} */
  const seen = [];
  /** @type {Record<string, unknown>[]} */
  const registered = [];
  let pages = 0;
  /** @type {Set<Response>} */
  const open = new Set();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    seen.push(`${req.method} ${path}`);
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
    } else if (path === "/types" && req.method === "POST") {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        registered.push(JSON.parse(text));
        json(201, JSON.parse(text));
      });
    } else if (path === "/types") {
      json(200, {
        data: [
          { id: "core.note", display_hints: { title_field: "title" } },
          ...registered,
        ],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json(200, { type_permissions: { "*": "write" } });
    } else if (path === "/items" && req.method === "POST") {
      const answer = () =>
        json(403, {
          error: { code: "forbidden", message: "no", details: { source: "x" } },
        });
      if (options.slowWrites) setTimeout(answer, 500);
      else answer();
    } else if (path === "/items") {
      pages += 1;
      if (options.slowPages && pages === 1) {
        setTimeout(() => json(200, { data: [], next_cursor: "c1" }), 500);
      } else {
        json(200, { data: [], next_cursor: null });
      }
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor === null) {
        res.end();
        return;
      }
      if (hold) {
        open.add(res);
        res.on("close", () => open.delete(res));
        const keepalive = setInterval(() => res.write(": keepalive\n\n"), 50);
        res.on("close", () => clearInterval(keepalive));
      } else {
        res.write(marker("stream_live", cursor));
        res.end();
      }
    } else {
      json(404, { error: { code: "not_found", message: "no such door" } });
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
    seen,
    registered,
    /** Holds the next stream open before its live marker, as a server still behind does. */
    holdStreams: () => {
      hold = true;
    },
    close: () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** @param {import("node:test").TestContext} t */
function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "core.sqlite");
}

/** @param {Promise<unknown>} pending */
async function refusal(pending) {
  try {
    await pending;
  } catch (error) {
    return /** @type {Error} */ (error);
  }
  throw new Error("the call was not refused");
}

test("an app saves with no server, is checked against its declared types, and joins later", async (t) => {
  const path = storeFor(t);
  (() => {
    const copy = MarfaCore.open(path);
    assert.equal(copy.status().hydration, Hydration.Never);
    copy.declareTypes([
      {
        id: "app.recipe",
        fields: { title: { type: "string", required: true } },
      },
    ]);
    assert.deepEqual(
      copy.declaredTypes().map((held) => held.id),
      ["app.recipe"],
    );
    const refused = (() => {
      try {
        copy.createItem({ type: "app.recipe", properties: {} });
      } catch (error) {
        return /** @type {Error} */ (error);
      }
      return null;
    })();
    assert.ok(refused, "a write missing a required field was queued");
    assert.match(refused.message, /^validation/);
    // The witness: the same write with the field is taken.
    copy.createItem({ type: "app.recipe", properties: { title: "Soup" } });
    assert.equal(copy.queue().length, 1);
  })();
  const server = await serving();
  t.after(server.close);
  // Let go of the store, as the app does when it quits, and open it again
  // with a server.
  /** @type {MarfaCore | undefined} */
  let joined;
  for (let tries = 0; tries < 200; tries += 1) {
    globalThis.gc?.();
    const opened = MarfaCore.open(path, server.url, "k");
    if (opened.heldHandle() === Handle.Writer) {
      joined = opened;
      break;
    }
    await sleep(25);
  }
  assert.ok(joined, "the store was never let go of");
  const report = await joined
    .hydrate(["app.recipe"], Tier.Library)
    .catch((e) => {
      console.log(server.seen);
      throw e;
    });
  assert.deepEqual(report.registeredTypes, ["app.recipe"]);
  assert.equal(server.registered.length, 1);
  assert.equal(joined.queue().length, 1);
});

test("a hydration given a stop that is raised in flight ends canceled and leaves an unfinished copy", async (t) => {
  const server = await serving({ slowPages: true });
  t.after(server.close);
  const core = MarfaCore.open(storeFor(t), server.url, "k");
  const stop = new Stop();
  const pending = core.hydrate(["core.note"], Tier.Library, stop);
  await sleep(150);
  stop.raise();
  const error = await refusal(pending);
  assert.equal(/** @type {{ code?: string }} */ (error).code, "GenericFailure");
  assert.match(error.message, /^canceled/);
  assert.equal(server.seen.filter((line) => line === "GET /items").length, 1);
  assert.notEqual(core.status().hydration, Hydration.Complete);
  assert.throws(() => core.get("x"), /hydration_incomplete/);
  // The witness: the same copy hydrates when it is not stopped.
  await core.hydrate(["core.note"], Tier.Library);
  assert.equal(core.status().hydration, Hydration.Complete);
});

test("a catch-up given a stop that is raised in flight ends canceled", async (t) => {
  const server = await serving();
  t.after(server.close);
  const core = MarfaCore.open(storeFor(t), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  server.holdStreams();
  const stop = new Stop();
  const pending = core.catchUp(stop);
  await sleep(200);
  stop.raise();
  const error = await refusal(pending);
  assert.match(error.message, /^canceled/);
});

test("a drain given a stop that is raised in flight ends canceled and leaves the rest queued", async (t) => {
  const server = await serving({ slowWrites: true });
  t.after(server.close);
  const core = MarfaCore.open(storeFor(t), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  core.createItem({ type: "core.note", properties: { title: "a" } });
  core.createItem({ type: "core.note", properties: { title: "b" } });
  const stop = new Stop();
  const pending = core.drain(stop);
  await sleep(150);
  stop.raise();
  const error = await refusal(pending);
  assert.match(error.message, /^canceled/);
  const sent = server.seen.filter((line) => line === "POST /items").length;
  assert.equal(sent, 1, "a write was sent after the stop");
  const untouched = core
    .queue()
    .filter((write) => write.verdict === undefined || write.verdict === null);
  assert.ok(
    untouched.length >= 1,
    "the write that was not sent lost its place",
  );
});
