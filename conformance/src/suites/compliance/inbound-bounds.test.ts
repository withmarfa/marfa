import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { InboundDeliveryRow } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  answerToUnfinished,
  codeOf,
  idOf,
  openBody,
  send,
  sendChunked,
} from "../../utils/inbound-sender.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a receiving door holds a body to: the limit it names, the length it
 * refuses unread, the bytes it holds in flight across bodies, the endpoint or
 * key that goes while a body is on its way, and the exact byte at which what
 * it retains is full. Each fixture boots a server of its own for the settings
 * it names.
 */

const MAX_BYTES = 64;
const IN_FLIGHT_BYTES = 8;

interface Registration {
  /** On the server's address as it is now, which a restart changes. */
  readonly client: MarfaClient;
  id: string;
  keyId: string;
}

function minterOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

async function register(
  server: FreshServer,
  label: string,
): Promise<Registration> {
  const minted = await minterOf(server).createKey({
    label,
    source: label,
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  const clientOf = () =>
    new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key });
  const registered = await clientOf().registerConnector({ name: label });
  expect(registered.status).toBe(201);
  return {
    get client() {
      return clientOf();
    },
    id: registered.data.id,
    keyId: minted.data.id,
  };
}

async function endpoint(owner: Registration) {
  const made = await owner.client.createInboundEndpoint(owner.id);
  expect(made.status).toBe(201);
  return made.data;
}

async function stored(owner: Registration): Promise<InboundDeliveryRow[]> {
  const listed = await owner.client.listInboundDeliveries(owner.id, {
    state: "any",
  });
  expect(listed.status).toBe(200);
  return listed.data.data;
}

describe("the limit on a body, named by the instance", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-max-bytes", {
      MARFA_INBOUND_MAX_BYTES: String(MAX_BYTES),
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("stores a body of exactly MARFA_INBOUND_MAX_BYTES and refuses one byte more", async () => {
    const owner = await register(server, "max-bytes");
    const made = await endpoint(owner);
    idOf(await send(server.apiUrl, made.path, "x".repeat(MAX_BYTES)));
    idOf(
      await sendChunked(server.apiUrl, made.path, [
        Buffer.alloc(MAX_BYTES, 0x61),
      ]),
    );

    const declared = await send(
      server.apiUrl,
      made.path,
      "x".repeat(MAX_BYTES + 1),
    );
    expect(declared.status).toBe(413);
    expect(codeOf(declared)).toBe("request_too_large");
    const streamed = await sendChunked(server.apiUrl, made.path, [
      Buffer.alloc(MAX_BYTES + 1, 0x61),
    ]);
    expect(streamed.status).toBe(413);
    expect(codeOf(streamed)).toBe("request_too_large");
    // Over the limit in two chunks, neither of which is over it alone.
    const split = await sendChunked(server.apiUrl, made.path, [
      Buffer.alloc(MAX_BYTES, 0x61),
      Buffer.alloc(1, 0x61),
    ]);
    expect(split.status).toBe(413);

    expect((await stored(owner)).map((row) => row.size)).toEqual([
      MAX_BYTES,
      MAX_BYTES,
    ]);
  });

  it("refuses a declared length over the limit before it reads the body", async () => {
    const owner = await register(server, "declared-length");
    const made = await endpoint(owner);
    // Nothing of the body is sent. The read timeout is the default thirty
    // seconds, so the 408 that waiting for it would end in is not an answer
    // this test could be handed by a server that read.
    const refused = await answerToUnfinished(
      server.apiUrl,
      made.path,
      MAX_BYTES + 1,
    );
    expect(refused.status).toBe(413);
    expect(codeOf(refused)).toBe("request_too_large");
    expect(await stored(owner)).toEqual([]);
    // The witness: a length at the limit is read, and left unfinished it is
    // the read that goes unanswered.
    const open = openBody(server.apiUrl, made.path, MAX_BYTES, "x");
    open.finish("x".repeat(MAX_BYTES - 1));
    expect(idOf(await open.answer)).toBeDefined();
    expect(await stored(owner)).toHaveLength(1);
  });
});

describe("the bytes in flight, across bodies", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-in-flight-sum", {
      MARFA_INBOUND_IN_FLIGHT_BYTES: String(IN_FLIGHT_BYTES),
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  /** Waits until the bytes of the bodies in progress are counted, which a
   *  receipt that would pass the count is the one answer to. */
  async function untilHeld(path: string, probe: number): Promise<void> {
    await waitFor(
      "the bytes of the bodies in progress to be counted",
      async () =>
        (await send(server.apiUrl, path, "p".repeat(probe))).status === 503
          ? true
          : undefined,
      10_000,
      25,
    );
  }

  it("refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off", async () => {
    const stalled = await register(server, "in-flight-stalled");
    const prober = await register(server, "in-flight-prober");
    const held = await endpoint(stalled);
    const probe = await endpoint(prober);

    // One body of six, four of them in; another of four, three of them in.
    const first = openBody(server.apiUrl, held.path, 6, "aaaa");
    await untilHeld(probe.path, IN_FLIGHT_BYTES - 4 + 1);
    const second = openBody(server.apiUrl, held.path, 4, "bbb");
    await untilHeld(probe.path, IN_FLIGHT_BYTES - 7 + 1);

    // Seven held: one more byte fills the instance's eight, and two pass it.
    idOf(await send(server.apiUrl, probe.path, "p"));
    const over = await send(server.apiUrl, probe.path, "pp");
    expect(over.status).toBe(503);
    expect(codeOf(over)).toBe("inbound_unavailable");
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);

    // The second body ends, and what it held goes back with it.
    second.finish("b");
    idOf(await second.answer);
    idOf(await send(server.apiUrl, probe.path, "pppp"));
    expect((await send(server.apiUrl, probe.path, "ppppp")).status).toBe(503);
    first.finish("aa");
    idOf(await first.answer);

    // A body that breaks off gives back what it had read.
    const broken = openBody(server.apiUrl, held.path, 6, "cccc");
    await untilHeld(probe.path, IN_FLIGHT_BYTES - 4 + 1);
    broken.abandon();
    await waitFor(
      "the bytes of a broken body to be given back",
      async () =>
        (await send(server.apiUrl, probe.path, "p".repeat(IN_FLIGHT_BYTES)))
          .status === 202
          ? true
          : undefined,
      10_000,
      25,
    );
    expect(
      (await stored(stalled)).map((row) => row.size).sort((a, b) => a - b),
    ).toEqual([4, 6]);
  });

  it("refuses a body whose endpoint was retired while it arrived, and stores nothing", async () => {
    const owner = await register(server, "retired-while-arriving");
    const prober = await register(server, "retired-prober");
    const made = await endpoint(owner);
    const probe = await endpoint(prober);

    const body = openBody(server.apiUrl, made.path, 6, "xxxx");
    // The request has been admitted and its bytes counted, so a retirement
    // from here is one the body arrived through.
    await untilHeld(probe.path, IN_FLIGHT_BYTES - 4 + 1);
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, made.id)).status,
    ).toBe(200);
    body.finish("yy");
    const answer = await body.answer;
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("not_found");
    expect(await stored(owner)).toEqual([]);

    // The bytes it held are given back.
    idOf(await send(server.apiUrl, probe.path, "p".repeat(IN_FLIGHT_BYTES)));
  });

  it("refuses a body whose key was revoked while it arrived", async () => {
    const owner = await register(server, "revoked-while-arriving");
    const prober = await register(server, "revoked-prober");
    const made = await endpoint(owner);
    const probe = await endpoint(prober);

    const body = openBody(server.apiUrl, made.path, 6, "xxxx");
    await untilHeld(probe.path, IN_FLIGHT_BYTES - 4 + 1);
    expect((await minterOf(server).revokeKey(owner.keyId)).status).toBe(200);
    body.finish("yy");
    const answer = await body.answer;
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("not_found");

    // Nothing the revoked body carried is on the instance: the registration
    // survives its key, and a key of the operator's reads no deliveries, so
    // the bytes' return is the observable.
    idOf(await send(server.apiUrl, probe.path, "p".repeat(IN_FLIGHT_BYTES)));
  });
});

describe("the retained bytes of a registration, to the byte", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-retained-boundary");
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  /** The charge of a receipt: its body, the canonical text of what is stored
   *  beside it, and thirty-two bytes. */
  function charge(row: InboundDeliveryRow, connectorId: string, body: Buffer) {
    const metadata = {
      id: row.id,
      endpoint_id: row.endpoint_id,
      connector_id: connectorId,
      received_at: row.received_at,
      method: row.method,
      query: row.query,
      headers: row.headers,
      size: row.size,
      sha256: row.sha256,
      dedupe_key: null,
      handled_at: null,
      outcome: null,
    };
    return body.length + Buffer.byteLength(JSON.stringify(metadata)) + 32;
  }

  it("takes a second receipt at exactly twice the charge of the first and refuses it one byte under", async () => {
    const body = Buffer.from('{"event":"charged","note":"é世"}');
    const headers = ["Host", "inbound.example", "X-Event", "charged"];
    const query = "a=1&b=%20two";
    const owner = await register(server, "retained-boundary");
    const made = await endpoint(owner);
    const receipt = (base: string) =>
      send(base, `${made.path}?${query}`, body, headers);

    idOf(await receipt(server.apiUrl));
    const [first] = await stored(owner);
    if (first === undefined) throw new Error("the first receipt was not kept");
    const each = charge(first, owner.id, body);

    // Two charges fit exactly, and one byte less does not take the second.
    await server.restart({
      env: { MARFA_INBOUND_RETAINED_BYTES: String(2 * each - 1) },
    });
    const under = await receipt(server.apiUrl);
    expect(under.status).toBe(503);
    expect(codeOf(under)).toBe("inbound_unavailable");
    expect(await stored(owner)).toHaveLength(1);

    await server.restart({
      env: { MARFA_INBOUND_RETAINED_BYTES: String(2 * each) },
    });
    idOf(await receipt(server.apiUrl));
    const kept = await stored(owner);
    expect(kept).toHaveLength(2);
    const [, second] = kept;
    if (second === undefined) throw new Error("the second was not kept");
    expect(charge(second, owner.id, body)).toBe(each);

    // Full: a third needs another charge.
    const third = await receipt(server.apiUrl);
    expect(third.status).toBe(503);
  });
});
