// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarfaCore, SliceTier } from "../index.js";

export const CONTRACT = /** @type {{ info: { version: string } }} */ (
  JSON.parse(readFileSync(new URL("../../../../openapi.json", import.meta.url), "utf8"))
).info.version;
export const INSTANCE = "00000000-0000-7000-8000-000000000000";
export const FENCE = "a".repeat(64);

/**
 * The scripted JSON reads below model a single certified reach. Writes, root
 * descriptions and the count of items by type carry no read proof; the bulk
 * read by id is a read sent as a `POST`. Item listing flags remain explicit in
 * each fixture's body.
 * @param {import("node:http").IncomingMessage} req
 */
export function readProof(req) {
  const read =
    req.method === "GET" ||
    (req.method === "POST" && req.url === "/items/bulk-get");
  const path = new URL(req.url ?? "", "http://fixture").pathname;
  if (!read || path === "/" || path === "/items/stats") return {};
  assert.equal(req.headers["x-marfa-reach"], FENCE);
  return { "x-marfa-reach": FENCE };
}

/** @param {"stream_cursor" | "stream_live"} type @param {string} cursor */
export function marker(type, cursor) {
  return `event: ${type}\ndata: ${JSON.stringify({ event_type: type, cursor, instance_id: INSTANCE, reach: FENCE })}\n\n`;
}

/**
 * Starts a copy stream, returning its resume cursor or null for bootstrap.
 * The caller must explicitly send live only after its replay is complete.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function streamHead(req, res) {
  assert.equal(new URL(req.url ?? "", "http://fixture").searchParams.get("copy"), "1");
  const cursor = req.headers["last-event-id"];
  assert.ok(cursor === undefined || typeof cursor === "string");
  assert.equal(req.headers["x-marfa-reach"], cursor === undefined ? undefined : FENCE);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-marfa-contract": CONTRACT,
  });
  res.write(": connected\n\n" + marker("stream_cursor", cursor ?? "10"));
  return cursor ?? null;
}

export const AT = "2026-01-01T00:00:00Z";

/**
 * @param {string} id
 * @param {number} cursor
 */
export function created(id, cursor) {
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
    event_type: "item.created",
    listed: true,
    item,
    metadata: { tags: [] },
  });
  return `id: ${cursor}\nevent: item.created\ndata: ${data}\n\n`;
}

/** @typedef {import("node:http").ServerResponse} Response */
/** @typedef {import("../index.js").Subscription} Subscription */

/** @param {Response} res */
export function held(res) {
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 50);
  res.on("close", () => clearInterval(keepalive));
}

/**
 * @param {Array<(res: Response) => void>} streams
 * @param {() => boolean} [registered] adds a type to the catalog
 */
export async function scripted(streams, registered = () => false) {
  /** @type {Set<Response>} */
  const open = new Set();
  let followed = 0;
  let asked = 0;
  let building = false;
  const server = createServer((req, res) => {
    asked += 1;
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
          { id: "core.note", display_hints: { title_field: "title" } },
          ...(registered()
            ? [{ id: "acme.late", parent: "core.note", version: 0, fields: {} }]
            : []),
        ],
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
    asked: () => asked,
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
export function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "core.sqlite");
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Array<(res: Response) => void>} streams
 */
export async function hydrated(t, streams) {
  const server = await scripted(streams);
  t.after(server.close);
  const path = storeFor(t);
  const core = MarfaCore.open(path, server.url, "k");
  await core.hydrate(["core.note"], SliceTier.Library);
  return { server, path, core };
}
