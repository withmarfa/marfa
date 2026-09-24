// @ts-check
// What a drain tells a Node caller, against a server this file scripts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BlockedReason, MarfaCore, Tier } from "../index.js";

/** The contract every answer names, as a real server's does: the one the
 * core is built for, read off the document it is built from. */
const CONTRACT = /** @type {{ info: { version: string } }} */ (
  JSON.parse(readFileSync(new URL("../../../../openapi.json", import.meta.url), "utf8"))
).info.version;

/**
 * A server that hydrates an empty `core.note` slice and refuses every create
 * for a source the credential's key does not claim.
 */
async function unclaiming() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-marfa-contract": CONTRACT,
      });
      res.end(JSON.stringify(body));
    };
    if (path === "/types") {
      json(200, {
        data: [{ id: "core.note", display_hints: { title_field: "title" } }],
        next_cursor: null,
      });
    } else if (path === "/items" && req.method === "POST") {
      json(403, {
        error: {
          code: "forbidden",
          message: "not claimed",
          details: { source: "notes" },
        },
      });
    } else if (path === "/items") {
      json(200, { data: [], next_cursor: null });
    } else if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-marfa-contract": CONTRACT,
      });
      res.end(
        ': connected\n\nevent: stream_cursor\ndata: {"type":"stream_cursor","cursor":"10"}\n\n',
      );
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
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("names a source its key does not claim", async (t) => {
  // `credential_refused` alone reads as a key that stopped working; the
  // report says which claim is missing (`queue-and-verdicts.md` 40).
  const server = await unclaiming();
  t.after(server.close);
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const core = MarfaCore.open(join(dir, "core.sqlite"), server.url, "k");
  await core.hydrate(["core.note"], Tier.Library);
  core.createItem({
    type: "core.note",
    properties: { title: "a" },
    source: "notes",
    sourceId: "a.md",
    baseVersion: 0,
  });
  const report = await core.drain();
  assert.equal(report.sent, 1);
  assert.deepEqual(report.unclaimedSources, ["notes"]);
  assert.deepEqual(report.verdicts[0]?.verdict, {
    verdict: "blocked",
    reason: BlockedReason.CredentialRefused,
  });
});
