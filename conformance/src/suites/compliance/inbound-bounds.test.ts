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
  openCounted,
  send,
  sendChunked,
  type RawAnswer,
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
const IN_FLIGHT_BYTES = 4096;

interface Registration {
  /** On the server's address as it is now, which a restart changes. */
  readonly client: MarfaClient;
  id: string;
  keyId: string;
  source: string;
}

/** A `Retry-After` in whole seconds, and not zero. */
function expectRetryAfter(answer: RawAnswer, what: string): void {
  expect(answer.headers["retry-after"], what).toMatch(/^[1-9]\d*$/);
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
    source: label,
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

  /** What a source may hold of the bytes in flight. */
  const PER_SOURCE = IN_FLIGHT_BYTES / 2;
  /** More than the headers of any receipt here hold, so that a sum is judged
   *  against a limit by a margin and not to the byte. */
  const MARGIN = 150;

  interface Held {
    owner: Registration;
    made: Awaited<ReturnType<typeof endpoint>>;
    body: ReturnType<typeof openBody>;
    /** Sends the rest of the declared length. */
    end(): Promise<RawAnswer>;
  }

  /** A source with a body declared at `declared` bytes, all but a hundred of
   *  them sent, and its bytes counted. */
  async function hold(label: string, declared: number): Promise<Held> {
    const owner = await register(server, label);
    const made = await endpoint(owner);
    const body = await openCounted(
      server,
      made.path,
      declared,
      "x".repeat(declared - 100),
    );
    return {
      owner,
      made,
      body,
      end() {
        body.finish("y".repeat(100));
        return body.answer;
      },
    };
  }

  async function sizes(owner: Registration): Promise<number[]> {
    return (await stored(owner))
      .map((row) => row.size)
      .filter((size) => size >= 1000)
      .sort((a, b) => a - b);
  }

  it("refuses a body that would pass the bytes in flight summed across bodies, takes one that fills them, and gives back what a body held when it ended or broke off", async () => {
    const prober = await register(server, "in-flight-prober");
    const probe = await endpoint(prober);

    // Two sources hold bodies of 1800 and 1500 bytes, with 3300 and the
    // headers counted of the 4096.
    const first = await hold("in-flight-first", 1800);
    const second = await hold("in-flight-second", 1500);

    const over = await send(server.apiUrl, probe.path, "p".repeat(1000));
    expect(over.status).toBe(503);
    expect(codeOf(over)).toBe("inbound_unavailable");
    expectRetryAfter(over, "bytes in flight");
    idOf(await send(server.apiUrl, probe.path, "p".repeat(300)));

    // The second body ends, and what it held goes back with it: 1700 more
    // pass now and did not while it was held.
    idOf(await second.end());
    idOf(await send(server.apiUrl, probe.path, "p".repeat(1700)));
    idOf(await first.end());

    // A body that breaks off gives back what it had read.
    const broken = await openCounted(
      server,
      first.made.path,
      1800,
      "c".repeat(1700),
    );
    broken.abandon();
    await waitFor(
      "the bytes of a broken body to be given back",
      async () =>
        (
          await send(
            server.apiUrl,
            first.made.path,
            "p".repeat(PER_SOURCE - 1800 + MARGIN),
          )
        ).status === 202
          ? true
          : undefined,
      10_000,
      25,
    );
    expect(await sizes(first.owner)).toEqual([1800]);
    expect(await sizes(second.owner)).toEqual([1500]);
  });

  it("refuses a source's receipt that would pass half the bytes in flight, and takes another source's", async () => {
    const held = await hold("in-flight-half", 1900);
    const other = await register(server, "in-flight-other");
    const elsewhere = await endpoint(other);

    const refused = await send(
      server.apiUrl,
      held.made.path,
      "n".repeat(PER_SOURCE - 1900 + MARGIN),
    );
    expect(refused.status).toBe(503);
    expect(codeOf(refused)).toBe("inbound_unavailable");
    expectRetryAfter(refused, "a source's half of the bytes in flight");

    // The instance has room: another source holds as much as this one does.
    idOf(await send(server.apiUrl, elsewhere.path, "o".repeat(1900)));
    idOf(await held.end());
    expect(await sizes(held.owner)).toEqual([1900]);
    expect(await sizes(other)).toEqual([1900]);
  });

  it("refuses a body whose endpoint was retired while it arrived, and stores nothing", async () => {
    const prober = await register(server, "retired-prober");
    const probe = await endpoint(prober);
    const owner = await hold("retired-while-arriving", 1800);
    // Another body fills the rest of what the instance holds, so that the
    // bytes the retired one gives back are the room for the receipt below.
    const filler = await hold("retired-filler", 1800);

    expect(
      (
        await owner.owner.client.retireInboundEndpoint(
          owner.owner.id,
          owner.made.id,
        )
      ).status,
    ).toBe(200);
    const answer = await owner.end();
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("not_found");
    expect(await sizes(owner.owner)).toEqual([]);

    // The bytes it held are given back: with both held, 1000 would not fit.
    idOf(await send(server.apiUrl, probe.path, "p".repeat(1000)));
    idOf(await filler.end());
  });

  it("refuses a body whose key was revoked while it arrived", async () => {
    const prober = await register(server, "revoked-prober");
    const probe = await endpoint(prober);
    const owner = await hold("revoked-while-arriving", 1800);
    const filler = await hold("revoked-filler", 1800);

    expect((await minterOf(server).revokeKey(owner.owner.keyId)).status).toBe(
      200,
    );
    const answer = await owner.end();
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("not_found");

    // Nothing the revoked body carried is on the instance: the registration
    // survives its key, and a key of the operator's reads no deliveries, so
    // the bytes' return is the observable.
    idOf(await send(server.apiUrl, probe.path, "p".repeat(1000)));
    idOf(await filler.end());
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

  function charge(row: InboundDeliveryRow, body: Buffer) {
    const headers = row.headers.reduce(
      (sum, [name, value]) =>
        sum + Buffer.byteLength(name) + Buffer.byteLength(value),
      0,
    );
    return body.length + Buffer.byteLength(row.query) + headers;
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
    const each = charge(first, body);

    // Two charges fit exactly, and one byte less does not take the second.
    await server.restart({
      env: { MARFA_INBOUND_RETAINED_BYTES: String(2 * each - 1) },
    });
    const under = await receipt(server.apiUrl);
    expect(under.status).toBe(503);
    expect(codeOf(under)).toBe("inbound_unavailable");
    expectRetryAfter(under, "retained bytes, one under");
    expect(await stored(owner)).toHaveLength(1);

    await server.restart({
      env: { MARFA_INBOUND_RETAINED_BYTES: String(2 * each) },
    });
    idOf(await receipt(server.apiUrl));
    const kept = await stored(owner);
    expect(kept).toHaveLength(2);
    const [, second] = kept;
    if (second === undefined) throw new Error("the second was not kept");
    expect(charge(second, body)).toBe(each);

    // Full: a third needs another charge.
    const third = await receipt(server.apiUrl);
    expect(third.status).toBe(503);
    expectRetryAfter(third, "retained bytes, full");
  });
});
