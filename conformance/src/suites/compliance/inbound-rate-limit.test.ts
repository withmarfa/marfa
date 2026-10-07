import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  answerToUnfinished,
  codeOf,
  idOf,
  send,
} from "../../utils/inbound-sender.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What the rate window counts and how long it runs, on an instance that
 * names both: three requests a window, and a window of three seconds.
 */

const REQUESTS = 3;
const WINDOW_MS = 3_000;
const MAX_BYTES = 64;

let server: FreshServer;
let minter: MarfaClient;
let serial = 0;

beforeAll(async () => {
  server = await bootFreshServer("inbound-rate-window", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_INBOUND_REQUESTS: String(REQUESTS),
    RATE_LIMIT_WINDOW_MS: String(WINDOW_MS),
    MARFA_INBOUND_MAX_BYTES: String(MAX_BYTES),
  });
  minter = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function liveEndpoint() {
  serial += 1;
  const label = `rate-window-${String(serial)}`;
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
  const made = await client.createInboundEndpoint(registered.data.id);
  expect(made.status).toBe(201);
  return { client, connectorId: registered.data.id, endpoint: made.data };
}

describe("the inbound rate window", () => {
  it("counts every request to a live address in its window, whatever answer it got", async () => {
    const { endpoint } = await liveEndpoint();
    // Two requests refused for their declared length, and one received.
    for (let i = 0; i < 2; i++) {
      const refused = await answerToUnfinished(
        server.apiUrl,
        endpoint.path,
        MAX_BYTES + 1,
      );
      expect(refused.status).toBe(413);
    }
    idOf(await send(server.apiUrl, endpoint.path, "x"));
    // One receipt in all: were only receipts counted, this would be taken.
    const spent = await send(server.apiUrl, endpoint.path, "x");
    expect(spent.status).toBe(429);
    expect(codeOf(spent)).toBe("rate_limited");
  });

  it("spends no window on an address nothing holds", async () => {
    const { client, connectorId, endpoint } = await liveEndpoint();
    for (let i = 0; i < REQUESTS + 3; i++) {
      const unknown = await send(
        server.apiUrl,
        `/inbound/${String(i).padStart(43, "B")}`,
        "x",
      );
      expect(unknown.status, String(i)).toBe(404);
    }
    // The witness: the live address took its three after them, and is
    // refused the fourth.
    for (let i = 0; i < REQUESTS; i++) {
      idOf(await send(server.apiUrl, endpoint.path, "x"));
    }
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(429);

    // And a retired address is one nothing holds, though its window is spent.
    expect(
      (await client.retireInboundEndpoint(connectorId, endpoint.id)).status,
    ).toBe(200);
    const retired = await send(server.apiUrl, endpoint.path, "x");
    expect(retired.status).toBe(404);
    expect(codeOf(retired)).toBe("not_found");
  });

  it("ends a window after RATE_LIMIT_WINDOW_MS, and tells a refused sender how long is left", async () => {
    const { endpoint } = await liveEndpoint();
    for (let i = 0; i < REQUESTS; i++) {
      idOf(await send(server.apiUrl, endpoint.path, "x"));
    }
    const spent = await send(server.apiUrl, endpoint.path, "x");
    expect(spent.status).toBe(429);
    // Seconds to the end of a window of three, not of the default minute.
    const retryAfter = Number(spent.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000));

    // A new window takes the full count again.
    await waitFor(
      "the window to end",
      async () =>
        (await send(server.apiUrl, endpoint.path, "x")).status === 202
          ? true
          : undefined,
      4 * WINDOW_MS,
      50,
    );
    for (let i = 0; i < REQUESTS - 1; i++) {
      idOf(await send(server.apiUrl, endpoint.path, "x"));
    }
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(429);
  });
});
