import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { movedClock, operatorOf, writerOf } from "../../utils/moved-clock.js";

/**
 * How long a link the instance serves lives, read against a clock the fixture
 * moves. A lifetime of seconds to days cannot be waited out, so the server's
 * clock is moved forward through the target interface and the link is fetched
 * again. The sweep that removes unreferenced blobs is off, so the clock move
 * does not take the bytes.
 */

let server: FreshServer;
let operator: MarfaClient;
let writer: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("blob-link-clock", {
    MARFA_BLOB_CLEANUP_INTERVAL_MS: "0",
  });
  operator = operatorOf(server);
  writer = writerOf(server);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** The seconds a fixture leaves for its own requests between a move of the
 *  clock and the fetch that follows, which run in real time. */
const MARGIN_S = 2;

/** Uploads bytes, links them from a note so the writer may read them, and
 *  answers a link of `ttl` seconds for them. */
async function linkOf(text: string, ttl: number) {
  const bytes = new TextEncoder().encode(text);
  const upload = await writer.uploadBlob(bytes, "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const note = await writer.createItem({
    type: "core.note",
    properties: { body: `![bytes](${upload.data.hash})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
  const link = await operator.getBlobUrl(upload.data.hash, ttl);
  expect(link.status, JSON.stringify(link.error)).toBe(200);
  expect(new URL(link.data.url).host).toBe(new URL(server.apiUrl).host);
  return { bytes, url: link.data.url, expiresIn: link.data.expires_in };
}

async function fetched(url: string): Promise<number> {
  const response = await fetch(url);
  await response.body?.cancel();
  return response.status;
}

describe("a link the instance serves", () => {
  it("works until its expires_in seconds have passed on the server's clock, and not after", async () => {
    const clock = movedClock(server);
    const ttl = 60;
    const link = await linkOf("a link that lives a minute", ttl);
    expect(link.expiresIn).toBe(ttl);
    // The witness for the refusal below: the link serves the bytes it names.
    const live = await fetch(link.url);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(link.bytes);

    await clock.advance((ttl - MARGIN_S) * 1000);
    expect(await fetched(link.url)).toBe(200);

    await clock.advance(2 * MARGIN_S * 1000);
    expect(await fetched(link.url)).toBe(401);
  });
});

describe("the longest a link lives", () => {
  it("is seven days from the answer that gave it, whatever lifetime was asked for", async () => {
    const clock = movedClock(server);
    const week = 7 * 24 * 60 * 60;
    const link = await linkOf("a link asked to live a fortnight", 2 * week);
    expect(link.expiresIn).toBe(week);

    // The witness: just inside the cap the link still serves, so the refusal
    // after it is the cap's and not a link that never worked.
    await clock.advance((week - MARGIN_S) * 1000);
    expect(await fetched(link.url)).toBe(200);

    await clock.advance(2 * MARGIN_S * 1000);
    expect(await fetched(link.url)).toBe(401);
  });
});
