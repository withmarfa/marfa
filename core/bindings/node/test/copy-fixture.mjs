// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const CONTRACT = /** @type {{ info: { version: string } }} */ (
  JSON.parse(readFileSync(new URL("../../../../openapi.json", import.meta.url), "utf8"))
).info.version;
export const INSTANCE = "00000000-0000-7000-8000-000000000000";
export const FENCE = "a".repeat(64);

/**
 * The scripted JSON reads below model a single certified view. Writes and
 * root descriptions carry no read proof. Item listing flags remain explicit
 * in each fixture's body.
 * @param {import("node:http").IncomingMessage} req
 */
export function readProof(req) {
  if (req.method !== "GET" || req.url === "/") return {};
  assert.equal(req.headers["x-marfa-read-view"], FENCE);
  return { "x-marfa-read-view": FENCE };
}

/** @param {"stream_cursor" | "stream_live"} type @param {string} cursor */
export function marker(type, cursor) {
  return `event: ${type}\ndata: ${JSON.stringify({ event_type: type, cursor, instance_id: INSTANCE, read_view: FENCE })}\n\n`;
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
  assert.equal(req.headers["x-marfa-read-view"], cursor === undefined ? undefined : FENCE);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-marfa-contract": CONTRACT,
  });
  res.write(": connected\n\n" + marker("stream_cursor", cursor ?? "10"));
  return cursor ?? null;
}
