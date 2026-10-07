import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  answerToUnfinished,
  idOf,
  send,
  sendChunked,
} from "../../utils/inbound-sender.js";
import { waitFor } from "../../utils/wait.js";

/**
 * A receiving address is a credential, so it is written to the server's log
 * only as `/inbound/****` and its last four characters, and nothing a sender
 * put in a receipt is written at all. The log is the file the fixture's own
 * server writes in its state directory.
 */

const MAX_BYTES = 64;

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("inbound-logs", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_INBOUND_REQUESTS: "3",
    MARFA_INBOUND_MAX_BYTES: String(MAX_BYTES),
    MARFA_INBOUND_BACKLOG_DELIVERIES: "2",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

const readLog = () => readFileSync(join(server.stateDir, "server.log"), "utf8");

/** A value no other text in the log could be: unlike a fixed word, it cannot
 *  be there for another reason. */
const sentinel = (kind: string) => `${kind}-${randomBytes(9).toString("hex")}`;

async function registration(label: string) {
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  }).createKey({ label, source: label, default_tier: "library" });
  expect(minted.status).toBe(201);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const registered = await client.registerConnector({ name: label });
  expect(registered.status).toBe(201);
  const made = await client.createInboundEndpoint(registered.data.id);
  expect(made.status).toBe(201);
  return { client, id: registered.data.id, endpoint: made.data };
}

describe("the server's log", () => {
  it("writes no address, header, query or body of a receipt, where another door's path is written", async () => {
    const query = sentinel("query");
    const header = sentinel("header");
    const body = sentinel("body");
    const named = (path: string) => `${path}?q=${query}`;
    const headers = ["X-Sentinel", header];

    const roomy = await registration("logs-roomy");
    const tight = await registration("logs-tight");
    const retired = await registration("logs-retired");
    const unknown = `/inbound/${randomBytes(32).toString("base64url")}`;
    const shouted = `/INBOUND/${randomBytes(32).toString("base64url")}`;

    // A receipt, and each refusal a receipt meets: an address nothing holds
    // in two spellings, one that was retired, a declared length and a body
    // read over the limit, a backlog that is full, and a spent window.
    idOf(await send(server.apiUrl, named(roomy.endpoint.path), body, headers));
    expect(
      (await send(server.apiUrl, named(unknown), body, headers)).status,
    ).toBe(404);
    expect(
      (await send(server.apiUrl, named(shouted), body, headers)).status,
    ).toBe(404);
    expect(
      (
        await retired.client.retireInboundEndpoint(
          retired.id,
          retired.endpoint.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await send(server.apiUrl, named(retired.endpoint.path), body, headers))
        .status,
    ).toBe(404);
    expect(
      (
        await answerToUnfinished(
          server.apiUrl,
          named(roomy.endpoint.path),
          MAX_BYTES + 1,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await sendChunked(server.apiUrl, named(roomy.endpoint.path), [
          Buffer.from(body.repeat(MAX_BYTES)),
        ])
      ).status,
    ).toBe(413);
    for (let i = 0; i < 2; i++) {
      idOf(
        await send(server.apiUrl, named(tight.endpoint.path), body, headers),
      );
    }
    expect(
      (await send(server.apiUrl, named(tight.endpoint.path), body, headers))
        .status,
    ).toBe(503);
    expect(
      (await send(server.apiUrl, named(roomy.endpoint.path), body, headers))
        .status,
    ).toBe(429);

    // Whatever the server wrote about these, it had written once it has
    // written about a request made after them.
    const marker = sentinel("marker");
    const read = await fetch(`${server.apiUrl}/connectors/${roomy.id}`, {
      headers: {
        Authorization: `Bearer ${server.operatorKey}`,
        "X-Request-ID": marker,
      },
    });
    expect(read.status).toBe(200);
    const log = await waitFor(
      "the log to hold the marker request",
      async () => {
        const text = readLog();
        return text.includes(marker) ? text : undefined;
      },
      10_000,
      25,
    );

    // The witnesses: the log is read after the requests, writes their
    // lines, writes the address redacted, and writes another door's path
    // whole.
    expect(log).toContain(
      `"path":"/inbound/****${roomy.endpoint.path.slice(-4)}"`,
    );
    for (const address of [unknown, shouted]) {
      expect(log).toContain(`"path":"/inbound/****${address.slice(-4)}"`);
    }
    expect(log).toContain(`"path":"/connectors/${roomy.id}/endpoints"`);
    // Every receipt above has its line: the spelling the router does not
    // serve has none that names the route.
    expect(log.match(/"route":"\/inbound\/\{token\}"/g)).toHaveLength(9);

    for (const address of [
      roomy.endpoint.path,
      tight.endpoint.path,
      retired.endpoint.path,
      unknown,
      shouted,
    ]) {
      const token = address.slice(address.lastIndexOf("/") + 1);
      // All of it but the last four characters, and the last five, which
      // would show the character before them.
      expect(log, address).not.toContain(token.slice(0, token.length - 4));
      expect(log, address).not.toContain(token.slice(-5));
    }
    for (const value of [query, header, body]) {
      expect(log, value).not.toContain(value);
    }
  });
});
