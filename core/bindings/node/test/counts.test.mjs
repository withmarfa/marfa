// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarfaCore } from "../index.js";
import { CONTRACT } from "./copy-fixture.mjs";

const ONE = "01a1011a-4902-76cf-a4a9-88e99c038c8d";

test("a count of links is refused not_answerable where the copy holds no edge type whole, and a request must name one thing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-counts-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    await assert.rejects(
      core.counts([ONE], { backref: "parent-of" }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, "not_answerable");
        assert.equal(error.server, undefined);
        return true;
      },
    );
    await assert.rejects(
      core.counts([ONE], { backref: "parent-of", table: "messages" }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, "validation");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("servedCounts asks the copy's own server, says held: false and refuses an answer off the declared shape or with an impossible number", async () => {
  /** @type {unknown} */
  let answer;
  /** @type {unknown[]} */
  const asked = [];
  const server = createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      asked.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(null)),
  );
  const address = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-counts-"));
  try {
    const core = MarfaCore.open(
      join(dir, "copy.sqlite"),
      `http://127.0.0.1:${address.port}`,
      "key",
    );
    const groups = {
      not_started: 1,
      in_progress: 0,
      completed: 0,
      canceled: 0,
    };
    answer = { counts: [{ id: ONE, total: 1, status_groups: groups }] };
    assert.deepEqual(
      await core.servedCounts([ONE, ONE], { backref: "parent-of" }),
      {
        counts: [{ id: ONE, total: 1, status_groups: groups, held: false }],
      },
    );
    assert.deepEqual(asked, [{ ids: [ONE], backref: "parent-of" }]);
    const link = { backref: "parent-of" };
    const rows = { table: "messages" };
    for (const [what, counted, refused] of [
      ["a link without groups", link, { counts: [{ id: ONE, total: 1 }] }],
      [
        "groups null on a row",
        rows,
        { counts: [{ id: ONE, total: 1, status_groups: null }] },
      ],
      [
        "unnamed groups",
        link,
        { counts: [{ id: ONE, total: 4, status_groups: [1, 1, 1, 1] }] },
      ],
      ["a positional answer", rows, [[{ id: ONE, total: 1 }]]],
      ["a negative total", rows, { counts: [{ id: ONE, total: -1 }] }],
      [
        "groups above the total",
        link,
        { counts: [{ id: ONE, total: 0, status_groups: groups }] },
      ],
    ]) {
      answer = refused;
      await assert.rejects(
        core.servedCounts([ONE], /** @type {any} */ (counted)),
        (/** @type {any} */ error) => {
          assert.equal(error.code, "decoding", String(what));
          return true;
        },
      );
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
