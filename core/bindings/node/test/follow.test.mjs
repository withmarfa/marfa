// @ts-check
// Run with `--expose-gc`: one case lets a subscription be collected.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Handle, MarfaCore, SliceTier } from "../index.js";
import {
  AT,
  CONTRACT,
  INSTANCE,
  created,
  held,
  hydrated,
  marker,
  readProof,
  scripted,
  storeFor,
  streamHead,
} from "./copy-fixture.mjs";

/** @typedef {import("node:http").ServerResponse} Response */
/** @typedef {import("../index.js").Subscription} Subscription */

test(
  "tells every change before it tells the end",
  { timeout: 20_000 },
  async (t) => {
    /** @type {() => void} */
    let sent = () => {};
    const flushed = new Promise((resolve) => (sent = () => resolve(undefined)));
    const { core } = await hydrated(t, [
      (res) => {
        let body = "";
        for (let cursor = 11; cursor <= 60; cursor += 1)
          body += created(`n${cursor}`, cursor);
        body +=
          'event: catchup_too_old\ndata: {"event_type":"catchup_too_old","min_retained_id":"500"}\n\n';
        res.end(body, sent);
      },
    ]);
    /** @type {string[]} */
    const told = [];
    // Held until the test ends: a subscription nobody holds ends its
    // follow when it is collected, which would end this one cleanly.
    /** @type {Subscription | undefined} */
    let subscription;
    t.after(() => subscription?.stop());
    /** @type {Promise<{ error: (Error & { code: string }) | null | undefined; before: number }>} */
    const ended = new Promise((resolve) => {
      subscription = core.follow(
        (change) => told.push(change.cursor),
        (error) => resolve({ error, before: told.length }),
      );
    });
    await flushed;
    // Busy while the follow applies the stream, so its calls queue up
    // behind this and are delivered together.
    const until = Date.now() + 300;
    while (Date.now() < until);
    const { error, before } = await ended;
    assert.equal(before, 50, "onEnd ran before every change sent ahead of it");
    assert.ok(error instanceof Error);
    assert.equal(error.code, "copy_expired");
    assert.match(error.message, /^copy_expired: /);
  },
);

test(
  "an onChange that throws ends the follow, and onEnd says what it threw",
  { timeout: 20_000 },
  async (t) => {
    const { core } = await hydrated(t, [
      (res) => {
        res.write(created("n11", 11) + created("n12", 12));
        held(res);
      },
    ]);
    let calls = 0;
    // Held until the test ends, for the reason the test above gives.
    /** @type {Subscription | undefined} */
    let subscription;
    t.after(() => subscription?.stop());
    /** @type {(Error & { code: string }) | null | undefined} */
    const error = await new Promise((resolve) => {
      subscription = core.follow(() => {
        calls += 1;
        throw new Error("the listener broke");
      }, resolve);
    });
    assert.ok(error instanceof Error);
    assert.equal(error.code, "listener_threw");
    assert.match(error.message, /^listener_threw: .*the listener broke/);
    assert.equal(calls, 1, "a listener that threw was called again");
  },
);

test(
  "a subscription nobody holds ends its follow once it is collected",
  { timeout: 20_000 },
  async (t) => {
    const { server, core } = await hydrated(t, [held]);
    let ended = false;
    (() => {
      core.follow(
        () => {},
        () => {
          ended = true;
        },
      );
    })();
    while (server.followed() === 0) await sleep(10);
    const deadline = Date.now() + 10_000;
    while (!ended && Date.now() < deadline) {
      globalThis.gc?.();
      await sleep(50);
    }
    assert.ok(
      ended,
      "a subscription nobody held was collected, and its follow went on holding the store",
    );
  },
);

test(
  "a follow in a worker that is torn down lets go of the store",
  { timeout: 30_000 },
  async (t) => {
    const server = await scripted([
      (res) => {
        let body = "";
        for (let cursor = 11; cursor <= 210; cursor += 1)
          body += created(`n${cursor}`, cursor);
        res.write(body);
        held(res);
      },
    ]);
    t.after(server.close);
    const path = storeFor(t);
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    const { MarfaCore, SliceTier } = require(workerData.module);
    // A follow's callbacks keep no thread alive, and this one must last
    // until it is torn down.
    setInterval(() => {}, 1000);
    const core = MarfaCore.open(workerData.path, workerData.url, "k");
    core.hydrate(["core.note"], SliceTier.Library).then(() => {
      core.follow(() => {
        parentPort.postMessage("told");
        // Every change after this one queues behind it until the worker goes.
        const until = Date.now() + 60000;
        while (Date.now() < until);
      }, () => {});
    });
    `,
      {
        eval: true,
        workerData: {
          module: fileURLToPath(new URL("../index.js", import.meta.url)),
          path,
          url: server.url,
        },
      },
    );
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    let handle = Handle.Reader;
    const deadline = Date.now() + 10_000;
    while (handle !== Handle.Writer && Date.now() < deadline) {
      handle = MarfaCore.open(path).heldHandle();
      if (handle !== Handle.Writer) await sleep(50);
    }
    assert.equal(
      handle,
      Handle.Writer,
      "a follow whose worker was torn down went on holding the store",
    );
  },
);

test(
  "a follow lets go of the store before it says it ended",
  { timeout: 20_000 },
  async (t) => {
    const server = await scripted([held]);
    t.after(server.close);
    const path = storeFor(t);
    /** @type {MarfaCore | null} */
    let core = MarfaCore.open(path, server.url, "k");
    await core.hydrate(["core.note"], SliceTier.Library);
    let collected = false;
    const registry = new FinalizationRegistry(() => {
      collected = true;
    });
    registry.register(core, "core");
    /** @type {(handle: Handle) => void} */
    let reopenedAs = () => {};
    const reopened = new Promise((resolve) => (reopenedAs = resolve));
    const subscription = core.follow(
      () => {},
      () => reopenedAs(MarfaCore.open(path).heldHandle()),
    );
    while (server.followed() === 0) await sleep(10);
    core = null;
    const deadline = Date.now() + 10_000;
    while (!collected && Date.now() < deadline) {
      globalThis.gc?.();
      await sleep(20);
    }
    assert.ok(collected, "the app's own handle was never collected");
    subscription.stop();
    assert.equal(
      await reopened,
      Handle.Writer,
      "a store opened again on being told the follow ended was still held by it",
    );
  },
);

test(
  "a store opened to read is never made, never the writer, and hears of saves",
  { timeout: 20_000 },
  async (t) => {
    const absent = storeFor(t);
    assert.throws(() => MarfaCore.openReader(absent), /^Error: invalid: /);
    assert.equal(
      existsSync(absent),
      false,
      "a reading open made a store where there was none",
    );

    const { path, core: writer } = await hydrated(t, [held]);
    const reader = MarfaCore.openReader(path);
    assert.equal(reader.heldHandle(), Handle.Reader);
    const before = reader.dataVersion();
    assert.equal(reader.dataVersion(), before, "the signal moved with no save");
    const queued = writer.createItem({
      type: "core.note",
      properties: { title: "saved" },
    });
    assert.notEqual(
      reader.dataVersion(),
      before,
      "the writer saved and the reader was not told",
    );
    assert.equal(reader.get(queued.itemId ?? "")?.properties.title, "saved");
    assert.throws(
      () =>
        reader.createItem({
          type: "core.note",
          properties: { title: "refused" },
        }),
      /^Error: reading_handle: /,
    );
  },
);

test(
  "tells a catalog that changed as a change of its own kind, and an event by its type",
  { timeout: 20_000 },
  async (t) => {
    let registered = false;
    const server = await scripted(
      [
        (res) => {
          res.write(created("n11", 11));
          held(res);
        },
      ],
      () => registered,
    );
    t.after(server.close);
    const core = MarfaCore.open(storeFor(t), server.url, "k");
    await core.hydrate(["core.note"], SliceTier.Library);
    registered = true;
    /** @type {import("../index.js").Change[]} */
    const told = [];
    const subscription = core.follow(
      (change) => told.push(change),
      () => {},
    );
    t.after(() => subscription.stop());
    const deadline = Date.now() + 10_000;
    while (told.length < 2 && Date.now() < deadline) await sleep(20);
    assert.deepEqual(
      told[0],
      { kind: "catalogChanged", cursor: "10" },
      "a changed catalog was not told as a change of its own kind",
    );
    const applied = told[1];
    assert.ok(applied?.kind === "applied", "an applied event was told as another kind");
    assert.deepEqual(
      [applied.event, applied.itemId, applied.cursor],
      ["item.created", "n11", "11"],
    );
  },
);

test(
  "waits for a first hydration, asking nothing, then follows",
  { timeout: 20_000 },
  async (t) => {
    const server = await scripted([
      (res) => {
        res.write(created("n11", 11));
        held(res);
      },
    ]);
    t.after(server.close);
    const core = MarfaCore.open(storeFor(t), server.url, "k");
    /** @type {import("../index.js").Change[]} */
    const told = [];
    /** @type {unknown} */
    let ended;
    const subscription = core.follow(
      (change) => told.push(change),
      (error) => {
        ended = error ?? "stopped";
      },
    );
    t.after(() => subscription.stop());
    await sleep(500);
    assert.equal(ended, undefined, "a follow on a copy never hydrated ended");
    assert.equal(server.asked(), 0, "a follow waiting for a hydration asked the server");

    await core.hydrate(["core.note"], SliceTier.Library);
    const deadline = Date.now() + 10_000;
    while (told.length === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(told[0]?.cursor, "11", "the follow did not follow once the copy was hydrated");
    subscription.stop();
    while (ended === undefined && Date.now() < deadline) await sleep(20);
    assert.equal(ended, "stopped");
  },
);

/**
 * A server that can be taken down and brought back: while down, every
 * stream is refused `503`. It takes every create and counts them.
 */
async function comingBack() {
  const state = { down: false, following: false, creates: 0 };
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map();
  /** @type {Set<Response>} */
  const open = new Set();
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
    } else if (path === "/items/lookup") {
      json(200, { data: [], tombstones: [] });
    } else if (path === "/items" && req.method === "POST") {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        state.creates += 1;
        const body = JSON.parse(text);
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
          occurred_at: AT,
          created_at: AT,
          updated_at: AT,
        };
        rows.set(body.id, item);
        json(201, { item });
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path.startsWith("/items/")) {
      const item = rows.get(decodeURIComponent(path.slice("/items/".length)));
      if (item) json(200, { item, metadata: { tags: [] }, listed: true });
      else json(404, { error: { code: "item_not_found", message: "no such item" } });
    } else if (path === "/events") {
      if (state.down) {
        json(503, { error: { code: "unavailable", message: "down" } });
        return;
      }
      const cursor = streamHead(req, res);
      if (cursor !== null) res.write(marker("stream_live", cursor));
      if (!state.following) {
        res.end();
        return;
      }
      open.add(res);
      res.on("close", () => open.delete(res));
      held(res);
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
    state,
    close: () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

test(
  "sends what waited once its server is back, and tells what the drain did",
  { timeout: 30_000 },
  async (t) => {
    const server = await comingBack();
    t.after(server.close);
    const core = MarfaCore.open(storeFor(t), server.url, "k");
    await core.hydrate(["core.note"], SliceTier.Library);
    core.createItem({ type: "core.note", properties: { title: "first" } });
    core.createItem({ type: "core.note", properties: { title: "second" } });
    server.state.down = true;
    server.state.following = true;
    /** @type {import("../index.js").Change[]} */
    const told = [];
    /** @type {unknown} */
    let ended;
    const subscription = core.follow(
      (change) => told.push(change),
      (error) => {
        ended = error ?? "stopped";
      },
    );
    t.after(() => subscription.stop());
    const deadline = Date.now() + 20_000;
    while (told.length === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(told[0]?.kind, "serverUnreachable");
    assert.equal(server.state.creates, 0, "a write was sent to a server that was down");
    server.state.down = false;
    while (!told.some((change) => change.kind === "queueDrained") && Date.now() < deadline)
      await sleep(20);
    const kinds = told.map((change) => change.kind);
    assert.deepEqual(
      kinds.slice(0, 3),
      ["serverUnreachable", "serverReachable", "queueDrained"],
      "the follow did not drain once its server was back, or did not say so",
    );
    const drained = told[2];
    assert.ok(drained?.kind === "queueDrained");
    assert.equal(drained.report.answered, 2);
    assert.equal(drained.report.verdicts.length, 2);
    assert.equal(server.state.creates, 2, "a write was not sent once");
    await sleep(300);
    assert.equal(server.state.creates, 2, "a drained queue was sent again");
    subscription.stop();
    while (ended === undefined && Date.now() < deadline) await sleep(20);
    assert.equal(ended, "stopped");
  },
);

test(
  "a follow told its caller was last told the server is unreachable tells it reachable at its first stream",
  { timeout: 20_000 },
  async (t) => {
    const { core } = await hydrated(t, [held]);
    /** @type {string[]} */
    const told = [];
    const subscription = core.follow(
      (change) => told.push(change.kind),
      () => {},
      true,
    );
    t.after(() => subscription.stop());
    const deadline = Date.now() + 10_000;
    while (told.length === 0 && Date.now() < deadline) await sleep(20);
    assert.deepEqual(told, ["serverReachable"]);
  },
);
