// @ts-check
// Run with `--expose-gc`: one case lets a subscription be collected.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Handle, MarfaCore, Tier } from "../index.js";
import { CONTRACT, INSTANCE, marker, readProof, streamHead } from "./copy-fixture.mjs";

const AT = "2026-01-01T00:00:00Z";

/**
 * @param {string} id
 * @param {number} cursor
 */
function created(id, cursor) {
  const item = {
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
  };
  const data = JSON.stringify({
    type: "item.created",
    listed: true,
    item,
    metadata: { tags: [] },
  });
  return `id: ${cursor}\nevent: item.created\ndata: ${data}\n\n`;
}

/** @typedef {import("node:http").ServerResponse} Response */
/** @typedef {import("../index.js").Subscription} Subscription */

/** @param {Response} res */
function held(res) {
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 50);
  res.on("close", () => clearInterval(keepalive));
}

/**
 * @param {Array<(res: Response) => void>} streams
 */
async function scripted(streams) {
  /** @type {Set<Response>} */
  const open = new Set();
  let followed = 0;
  let building = false;
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
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/edge-types") {
      json({ data: [], next_cursor: null });
    } else if (path === "/keys/current") {
      json({ type_permissions: { "*": "write" } });
    } else if (path === "/items") {
      json({ data: [], next_cursor: null });
    } else if (path === "/events") {
      const cursor = streamHead(req, res);
      if (cursor === null) {
        building = true;
        res.end();
        return;
      }
      res.write(marker("stream_live", cursor));
      // Hydration's replay establishes completeness before a separately
      // held follow exercises callback ordering and cancellation.
      if (building) {
        building = false;
        res.end();
        return;
      }
      followed += 1;
      open.add(res);
      res.on("close", () => open.delete(res));
      const next = streams.length > 1 ? streams.shift() : streams[0];
      next?.(res);
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
    followed: () => followed,
    close: () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * @param {import("node:test").TestContext} t
 */
function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "core.sqlite");
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Array<(res: Response) => void>} streams
 */
async function hydrated(t, streams) {
  const server = await scripted(streams);
  t.after(server.close);
  const path = storeFor(t);
  const core = MarfaCore.open(path, server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  return { server, path, core };
}

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
          'event: catchup_too_old\ndata: {"type":"catchup_too_old","min_retained_id":"500"}\n\n';
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
    const { MarfaCore, Tier } = require(workerData.module);
    // A follow's callbacks keep no thread alive, and this one must last
    // until it is torn down.
    setInterval(() => {}, 1000);
    const core = MarfaCore.open(workerData.path, workerData.url, "k");
    core.hydrate(["core.note"], Tier.Library).then(() => {
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
    await core.hydrate(["core.note"], Tier.Library);
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
