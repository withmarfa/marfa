// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { held, hydrated } from "./copy-fixture.mjs";

/** @typedef {import("../index.js").Subscription} Subscription */

test(
  "answers null, not undefined, from fillTables while a follow holds the stream, and a report once it ends",
  { timeout: 20_000 },
  async (t) => {
    const { core, server } = await hydrated(t, [(res) => held(res)]);

    // The witness: with the stream free the call answers its report.
    const free = await core.fillTables();
    assert.deepEqual(
      [free?.whole, free?.unfilled, free?.failed],
      [0, 0, 0],
      "a free stream did not answer a report, so the test proves nothing",
    );

    /** @type {() => void} */
    let over = () => {};
    const ended = new Promise((resolve) => (over = () => resolve(undefined)));
    /** @type {Subscription | undefined} */
    let subscription;
    t.after(() => subscription?.stop());
    subscription = core.follow(
      () => {},
      () => over(),
    );
    while (server.followed() === 0) await sleep(10);

    const answered = await core.fillTables();
    assert.strictEqual(
      answered,
      null,
      "fillTables did not answer the JavaScript value null",
    );

    subscription.stop();
    await ended;
    const after = await core.fillTables();
    assert.notStrictEqual(after, null);
    assert.equal(after?.failed, 0);
  },
);
