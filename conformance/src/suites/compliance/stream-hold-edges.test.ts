import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import type { SseEvent } from "../../utils/sse.js";
import {
  announces,
  tapStream,
  type StreamTap,
} from "../../utils/stream-tap.js";

/**
 * The edges of a hold on a stream: several streams waiting at one point, a
 * client that leaves while its stream waits, and a stop while streams wait.
 */

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

let server: FreshServer;
let stopped: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("stream-hold-edges");
  stopped = await bootFreshServer("stream-hold-edges-stop");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

const taps: StreamTap[] = [];
afterEach(async () => {
  await server.clearFault();
  await Promise.all(taps.splice(0).map((tap) => tap.close()));
});

afterAll(async () => {
  await Promise.all([server.stop(), stopped.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function open(
  options: Parameters<typeof tapStream>[2] = {},
  on = server,
): Promise<StreamTap> {
  const tap = await tapStream(on.apiUrl, on.workingKey, options);
  taps.push(tap);
  return tap;
}

const named =
  (name: string) =>
  (events: SseEvent[]): boolean =>
    events.some((event) => event.event === name);

async function note(label: string): Promise<string> {
  const created = await working.createItem({
    type: "core.note",
    properties: { body: label },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

async function waiting(name: string): Promise<number | undefined> {
  return (await server.faults()).find((fault) => fault.name === name)?.waiting;
}

describe("several streams held at one point", () => {
  it.each([
    ["stream-head", false],
    ["stream-drain", true],
  ] as const)(
    "all go on when the hold at %s is cleared, and each receives what was written meanwhile",
    async (point, withCopy) => {
      const name = `hold:${point}`;
      await server.setFault(name);
      const one = await open();
      const two = await open();
      // A copy stream's opening is bounded: held at the head it is ended
      // before the hold could be cleared, so only its drain is held here.
      const three = withCopy ? await open({ query: COPY_QUERY }) : undefined;
      const count = three ? 3 : 2;
      await server.waitForHold(name, count);
      expect(await waiting(name)).toBe(count);

      const written = await note(`written-while-held-at-${point}`);
      await server.clearFault(name);
      for (const tap of [one, two, three].filter((t) => t !== undefined)) {
        await tap.until(named("stream_live"), `a stream held at ${point} live`);
        const sentinel = await note(`sentinel-${point}`);
        const after = await tap.until(
          (seen) => seen.some(announces(sentinel)),
          `the sentinel after ${point}`,
        );
        // The frame held while the stream waited is delivered once.
        expect(after.filter(announces(written))).toHaveLength(1);
      }
    },
  );
});

describe("a client that leaves while its stream is held", () => {
  it.each([
    ["stream-head", {}],
    ["stream-replay", { lastEventId: "0" }],
    ["stream-drain", {}],
    ["stream-drain", { query: COPY_QUERY }],
  ] as const)(
    "leaves the server whole when %s is released after it left: %j",
    async (point, options) => {
      const name = `hold:${point}`;
      await server.setFault(name);
      const tap = await open({ ...options });
      await server.waitForHold(name);
      await tap.close();
      await server.clearFault(name);
      expect(await waiting(name)).toBeUndefined();

      // The server carries on: a stream opens, goes live and receives.
      const again = await open();
      await again.until(named("stream_live"), "a later stream live");
      const written = await note(`after-${point}`);
      await again.until(
        (seen) => seen.some(announces(written)),
        "the write on the later stream",
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a stop while a stream is held", () => {
  it("ends the held stream with server_stopping and exits with status 0, the hold being released as the stop begins", async () => {
    await stopped.setFault("hold:stream-drain");
    const tap = await open({}, stopped);
    await stopped.waitForHold("hold:stream-drain");

    stopped.signal("SIGTERM");
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(tap.events.at(-1)!.data).toMatchObject({
      reason: "server_stopping",
    });
    expect(await stopped.exit()).toMatchObject({ code: 0, signal: null });
  });

  it(
    "stops through the harness with a hold still armed",
    async () => {
      const own = await bootFreshServer("stream-hold-edges-harness-stop");
      await own.setFault("hold:stream-head");
      const tap = await tapStream(own.apiUrl, own.workingKey);
      await own.waitForHold("hold:stream-head");
      // The harness clears the fault before it stops the server, so a stream
      // waiting at the point does not keep the stop waiting.
      await own.stop();
      await tap.close();
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
