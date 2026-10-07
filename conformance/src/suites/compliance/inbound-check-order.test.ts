import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  codeOf,
  idOf,
  answerToUnfinished,
  send,
  sendChunked,
} from "../../utils/inbound-sender.js";

/**
 * Where one receipt meets two refusals, which of the two the sender is told.
 * Each pair has its witnesses: the request with only the first fault, and
 * the request with only the second, so that the answer names an order
 * rather than a refusal that never reaches the later check.
 */

const MAX_BYTES = 64;
const IN_FLIGHT_BYTES = 8;

let server: FreshServer;
let minter: MarfaClient;
let serial = 0;

beforeAll(async () => {
  server = await bootFreshServer("inbound-check-order", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_INBOUND_REQUESTS: "2",
    MARFA_INBOUND_BACKLOG_DELIVERIES: "1",
    MARFA_INBOUND_MAX_BYTES: String(MAX_BYTES),
    MARFA_INBOUND_IN_FLIGHT_BYTES: String(IN_FLIGHT_BYTES),
    MARFA_INBOUND_READ_TIMEOUT_MS: "1000",
  });
  minter = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Registration {
  client: MarfaClient;
  id: string;
}

/** A registration with no delivery yet, so its backlog is empty. */
async function registration(): Promise<Registration> {
  serial += 1;
  const label = `order-${String(serial)}`;
  const minted = await minter.createKey({
    label,
    source: label,
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const registered = await client.registerConnector({ name: label });
  expect(registered.status).toBe(201);
  return { client, id: registered.data.id };
}

async function endpoint(owner: Registration) {
  const made = await owner.client.createInboundEndpoint(owner.id);
  expect(made.status).toBe(201);
  return made.data;
}

describe("a receipt that meets two refusals", () => {
  it("answers an address no live endpoint holds 404 before the rate window and the declared length", async () => {
    const owner = await registration();
    const made = await endpoint(owner);
    idOf(await send(server.apiUrl, made.path, "x"));
    const full = await send(server.apiUrl, made.path, "x");
    expect(full.status).toBe(503);
    // The witness that the window is spent: the live address is refused.
    const spent = await send(server.apiUrl, made.path, "x");
    expect(spent.status).toBe(429);
    expect(codeOf(spent)).toBe("rate_limited");

    expect(
      (await owner.client.retireInboundEndpoint(owner.id, made.id)).status,
    ).toBe(200);
    const retired = await send(server.apiUrl, made.path, "x");
    expect(retired.status).toBe(404);
    expect(codeOf(retired)).toBe("not_found");

    // An address nothing holds is told 404 for a declared length that a live
    // address is told 413 for.
    const other = await registration();
    const live = await endpoint(other);
    const declared = await answerToUnfinished(
      server.apiUrl,
      live.path,
      MAX_BYTES + 1,
    );
    expect(declared.status).toBe(413);
    const unknown = await answerToUnfinished(
      server.apiUrl,
      `/inbound/${"A".repeat(43)}`,
      MAX_BYTES + 1,
    );
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe("not_found");
  });

  it("answers the rate window's 429 before the backlog's 503", async () => {
    const owner = await registration();
    const first = await endpoint(owner);
    const second = await endpoint(owner);
    idOf(await send(server.apiUrl, first.path, "x"));
    // The backlog is full from here, and this one spends the second place in
    // the window.
    const full = await send(server.apiUrl, first.path, "x");
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");

    const spent = await send(server.apiUrl, first.path, "x");
    expect(spent.status).toBe(429);
    expect(codeOf(spent)).toBe("rate_limited");
    // The witness: another endpoint of the registration has a window of its
    // own and meets the backlog that was full all along.
    const witness = await send(server.apiUrl, second.path, "x");
    expect(witness.status).toBe(503);
    expect(codeOf(witness)).toBe("inbound_unavailable");
  });

  it("answers a full backlog 503 before a declared length over the limit", async () => {
    const owner = await registration();
    const made = await endpoint(owner);
    idOf(await send(server.apiUrl, made.path, "x"));
    const full = await answerToUnfinished(
      server.apiUrl,
      made.path,
      MAX_BYTES + 1,
    );
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");

    // The witness: with room in the backlog, the same declaration is the
    // length's.
    const empty = await registration();
    const open = await endpoint(empty);
    const declared = await answerToUnfinished(
      server.apiUrl,
      open.path,
      MAX_BYTES + 1,
    );
    expect(declared.status).toBe(413);
    expect(codeOf(declared)).toBe("request_too_large");
  });

  it("answers a declared length over the limit 413 before the body's 408", async () => {
    const owner = await registration();
    const made = await endpoint(owner);
    // Nothing of the body is sent, so the 408 below would be the answer if
    // the server waited for it.
    const declared = await answerToUnfinished(
      server.apiUrl,
      made.path,
      MAX_BYTES + 1,
    );
    expect(declared.status).toBe(413);
    expect(codeOf(declared)).toBe("request_too_large");

    // The witness: a length within the limit, left unfinished, is the
    // timeout's.
    const stalled = await answerToUnfinished(
      server.apiUrl,
      made.path,
      10,
      "abc",
    );
    expect(stalled.status).toBe(408);
    expect(codeOf(stalled)).toBe("request_timeout");
  });

  it("answers a body read past the limit 413 before the bytes in flight's 503", async () => {
    const owner = await registration();
    const made = await endpoint(owner);
    const over = await sendChunked(server.apiUrl, made.path, [
      Buffer.alloc(MAX_BYTES + 1, 0x61),
    ]);
    expect(over.status).toBe(413);
    expect(codeOf(over)).toBe("request_too_large");

    // The witness: a body past the bytes in flight and under the limit is
    // refused for them.
    const flight = await sendChunked(server.apiUrl, made.path, [
      Buffer.alloc(IN_FLIGHT_BYTES + 1, 0x61),
    ]);
    expect(flight.status).toBe(503);
    expect(codeOf(flight)).toBe("inbound_unavailable");
    expect(
      (await owner.client.listInboundDeliveries(owner.id)).data.data,
    ).toEqual([]);
  });
});
