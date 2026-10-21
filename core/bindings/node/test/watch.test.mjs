// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Handle, MarfaCore, SliceTier } from "../index.js";
import { created, held, hydrated, scripted, storeFor } from "./copy-fixture.mjs";

/** @typedef {import("../index.js").Change} Change */
/** @typedef {import("../index.js").Subscription} Subscription */

/**
 * @param {string} what
 * @param {() => boolean} done
 */
async function until(what, done) {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await sleep(10);
  assert.ok(done(), what);
}

/** @param {Change[]} told */
const ids = (told) =>
  told.flatMap((change) => (change.kind === "applied" ? [change.itemId] : []));

test(
  "tells every listener of one stream each change, in order, and ends one without the other",
  { timeout: 20_000 },
  async (t) => {
    const { server, core } = await hydrated(t, [
      (res) => {
        res.write(created("n11", 11) + created("n12", 12));
        held(res);
      },
    ]);
    /** @type {Change[]} */
    const first = [];
    /** @type {Change[]} */
    const second = [];
    /** @type {Array<unknown>} */
    const ended = [];
    const one = core.watch(
      (change) => first.push(change),
      (error) => ended.push(error),
    );
    const two = core.watch(
      (change) => second.push(change),
      () => {},
    );
    t.after(() => two.stop());
    await until("both events were not told to both listeners", () =>
      [first, second].every((told) => ids(told).length === 2),
    );
    assert.deepEqual(ids(first), ["n11", "n12"]);
    assert.deepEqual(ids(second), ["n11", "n12"]);
    assert.equal(server.followed(), 1, "a second listener opened a second stream");

    one.stop();
    await until("a listener let go was never told it ended", () => ended.length === 1);
    assert.equal(ended[0], null);
    await sleep(100);
    assert.equal(ended.length, 1, "a listener let go was told it ended twice");
  },
);

test(
  "a hydration takes the stream from a watch and gives it back, ending no listener",
  { timeout: 20_000 },
  async (t) => {
    const { server, core } = await hydrated(t, [
      (res) => {
        res.write(created("n11", 11));
        held(res);
      },
    ]);
    /** @type {Change[]} */
    const told = [];
    /** @type {Array<unknown>} */
    const ended = [];
    const subscription = core.watch(
      (change) => told.push(change),
      (error) => ended.push(error),
    );
    t.after(() => subscription.stop());
    await until("the watch never held a stream", () => server.followed() === 1);
    await core.hydrate(["core.note"], SliceTier.Library);
    await until("the watch never held a stream again", () => server.followed() === 2);
    assert.deepEqual(ended, [], "a hydration ended a listener");
  },
);

test(
  "an onChange that throws ends its own listener, and the others go on",
  { timeout: 20_000 },
  async (t) => {
    const { core } = await hydrated(t, [
      (res) => {
        res.write(created("n11", 11) + created("n12", 12));
        held(res);
      },
    ]);
    let calls = 0;
    /** @type {Change[]} */
    const steady = [];
    /** @type {(Error & { code: string }) | null | undefined} */
    let broke;
    const faulting = core.watch(
      () => {
        calls += 1;
        throw new Error("the listener broke");
      },
      (error) => {
        broke = error;
      },
    );
    const other = core.watch(
      (change) => steady.push(change),
      () => {},
    );
    t.after(() => {
      faulting.stop();
      other.stop();
    });
    await until("the listener that threw was never ended", () => broke !== undefined);
    await until("the other listener missed an event", () => ids(steady).length === 2);
    assert.ok(broke instanceof Error);
    assert.equal(broke.code, "listener_threw");
    assert.match(broke.message, /^listener_threw: .*the listener broke/);
    assert.equal(calls, 1, "a listener that threw was called again");
  },
);

test(
  "a reading handle's watch tells each save, and a writer with no server cannot be watched",
  { timeout: 20_000 },
  async (t) => {
    const { path, core: writer } = await hydrated(t, [held]);
    const reader = MarfaCore.openReader(path);
    assert.equal(reader.heldHandle(), Handle.Reader);
    /** @type {Change[]} */
    const told = [];
    const subscription = reader.watch(
      (change) => told.push(change),
      () => {},
    );
    t.after(() => subscription.stop());
    const before = reader.dataVersion();
    writer.createItem({ type: "core.note", properties: { title: "saved" } });
    await until("the writer saved and the watch told nothing", () => told.length > 0);
    const saved = told[0];
    assert.ok(saved?.kind === "saved");
    assert.notEqual(saved.dataVersion, before);

    const alone = MarfaCore.open(storeFor(t));
    assert.throws(
      () =>
        alone.watch(
          () => {},
          () => {},
        ),
      /^Error: no_server: /,
    );
  },
);

test(
  "a server that cannot be reached is told once, with the reason",
  { timeout: 20_000 },
  async (t) => {
    const server = await scripted([held]);
    const core = MarfaCore.open(storeFor(t), server.url, "k");
    await core.hydrate(["core.note"], SliceTier.Library);
    server.close();
    /** @type {Change[]} */
    const told = [];
    const subscription = core.watch(
      (change) => told.push(change),
      () => {},
    );
    t.after(() => subscription.stop());
    await until("a server that was gone was not told", () =>
      told.some((change) => change.kind === "serverUnreachable"),
    );
    await sleep(300);
    const unreachable = told.filter((change) => change.kind === "serverUnreachable");
    assert.equal(unreachable.length, 1, "the loss was told more than once");
    const reason = unreachable[0]?.kind === "serverUnreachable" ? unreachable[0].reason : "";
    const origin = new URL(server.url).origin;
    assert.ok(reason.startsWith(`request to ${origin} failed: `), reason);
  },
);

test(
  "a listener told it was last told the server is unreachable is told it is reachable when the stream is had",
  { timeout: 20_000 },
  async (t) => {
    const { core } = await hydrated(t, [held]);
    /** @type {Change[]} */
    const told = [];
    const subscription = core.watch(
      (change) => told.push(change),
      () => {},
      true,
    );
    t.after(() => subscription.stop());
    await until("the listener was not told the server was reachable", () =>
      told.some((change) => change.kind === "serverReachable"),
    );
    assert.deepEqual(
      told.map((change) => change.kind),
      ["serverReachable"],
    );
  },
);
