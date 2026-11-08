import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  serverOutput,
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

  it("holds each endpoint to its own rate window", async () => {
    const { client, connectorId, endpoint: first } = await liveEndpoint();
    const second = await client.createInboundEndpoint(connectorId);
    expect(second.status).toBe(201);
    for (let i = 0; i < REQUESTS; i++) {
      idOf(await send(server.apiUrl, first.path, String(i)));
    }
    const refused = await send(server.apiUrl, first.path, "3");
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    idOf(await send(server.apiUrl, second.data.path, "0"));
  });

  it("writes the address of a request the window refuses as it writes any other, redacted", async () => {
    const { endpoint } = await liveEndpoint();
    for (let i = 0; i < REQUESTS; i++) {
      idOf(await send(server.apiUrl, endpoint.path, "x"));
    }
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(429);
    const token = endpoint.path.slice(endpoint.path.lastIndexOf("/") + 1);
    const log = await waitFor(
      "the log to hold the refused request",
      async () => {
        const text = serverOutput(server.stateDir);
        return text
          .split("\n")
          .some(
            (line) =>
              line.includes(`"path":"/inbound/****${token.slice(-4)}"`) &&
              line.includes('"status":429'),
          )
          ? text
          : undefined;
      },
      10_000,
      25,
    );
    expect(log).not.toContain(token.slice(0, token.length - 4));
    expect(log).not.toContain(token.slice(-5));
  });
});

describe("the inbound rate window against the checks around it", () => {
  const BACKLOG = 1;
  let order: FreshServer;
  let ordering: MarfaClient;

  beforeAll(async () => {
    order = await bootFreshServer("inbound-rate-order", {
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_INBOUND_REQUESTS: "2",
      MARFA_INBOUND_BACKLOG_DELIVERIES: String(BACKLOG),
    });
    ordering = new MarfaClient({
      baseUrl: order.apiUrl,
      apiKey: order.workingKey,
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await order.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function registered(label: string) {
    serial += 1;
    const source = `${label}-${String(serial)}`;
    const minted = await ordering.createKey({
      label: source,
      source,
      default_tier: "library",
    });
    expect(minted.status).toBe(201);
    const client = new MarfaClient({
      baseUrl: order.apiUrl,
      apiKey: minted.data.key,
    });
    const connector = await client.registerConnector({ name: source });
    expect(connector.status).toBe(201);
    return { client, id: connector.data.id };
  }

  it("answers an address no live endpoint holds 404 before the rate window", async () => {
    const owner = await registered("order-address");
    const made = await owner.client.createInboundEndpoint(owner.id);
    expect(made.status).toBe(201);
    idOf(await send(order.apiUrl, made.data.path, "x"));
    // The witness that the window is spent: the live address is refused.
    const full = await send(order.apiUrl, made.data.path, "x");
    expect(full.status).toBe(503);
    const spent = await send(order.apiUrl, made.data.path, "x");
    expect(spent.status).toBe(429);
    expect(codeOf(spent)).toBe("rate_limited");

    expect(
      (await owner.client.retireInboundEndpoint(owner.id, made.data.id)).status,
    ).toBe(200);
    const retired = await send(order.apiUrl, made.data.path, "x");
    expect(retired.status).toBe(404);
    expect(codeOf(retired)).toBe("not_found");
  });

  it("answers the rate window's 429 before the backlog's 503", async () => {
    const owner = await registered("order-window");
    const first = await owner.client.createInboundEndpoint(owner.id);
    const second = await owner.client.createInboundEndpoint(owner.id);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    idOf(await send(order.apiUrl, first.data.path, "x"));
    // Refused receipts still consume the endpoint's window.
    const full = await send(order.apiUrl, first.data.path, "x");
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");

    const spent = await send(order.apiUrl, first.data.path, "x");
    expect(spent.status).toBe(429);
    expect(codeOf(spent)).toBe("rate_limited");
    // A fresh endpoint witnesses the full backlog independently of the window.
    const witness = await send(order.apiUrl, second.data.path, "x");
    expect(witness.status).toBe(503);
    expect(codeOf(witness)).toBe("inbound_unavailable");
  });
});

describe("the inbound rate window across a successor key", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-rate-takeover", {
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_INBOUND_REQUESTS: "3",
      RATE_LIMIT_WINDOW_MS: "600000",
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("keeps the endpoint's window when a successor key takes its source over", async () => {
    const operator = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const source = "rate-takeover";
    const first = await operator.createKey({
      label: source,
      source,
      default_tier: "library",
    });
    expect(first.status).toBe(201);
    const old = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: first.data.key,
    });
    const registered = await old.registerConnector({ name: source });
    expect(registered.status).toBe(201);
    const made = await old.createInboundEndpoint(registered.data.id);
    expect(made.status).toBe(201);
    for (let i = 0; i < REQUESTS - 1; i++) {
      idOf(await send(server.apiUrl, made.data.path, "x"));
    }

    expect((await operator.revokeKey(first.data.id)).status).toBe(200);
    const second = await operator.createKey({
      label: `${source}-successor`,
      source,
      default_tier: "library",
    });
    expect(second.status).toBe(201);
    const successor = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: second.data.key,
    });
    expect((await successor.registerConnector({ name: source })).status).toBe(
      201,
    );

    // One place in the window is left, and the address is the same.
    idOf(await send(server.apiUrl, made.data.path, "x"));
    expect((await send(server.apiUrl, made.data.path, "x")).status).toBe(429);
  });
});
