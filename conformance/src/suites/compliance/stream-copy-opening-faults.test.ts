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
 * What a copy stream does when the server cannot read what it needs to open,
 * to replay, or to go on delivering: the head of the log, a page of the log or
 * the stream's credential.
 *
 * The fixtures set the failure or the hold through the target interface
 * (`conformance/README.md`, "Faults") on a server of their own. Failure faults
 * act once; hold faults remain armed until cleared.
 */

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("stream-opening-faults");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

const taps: StreamTap[] = [];
afterEach(async () => {
  await server.clearFault();
  await Promise.all(taps.splice(0).map((tap) => tap.close()));
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function open(
  options: Parameters<typeof tapStream>[2] = {},
  key = server.workingKey,
): Promise<StreamTap> {
  const tap = await tapStream(server.apiUrl, key, options);
  taps.push(tap);
  return tap;
}

async function note(body: string): Promise<string> {
  const created = await working.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

const named =
  (name: string) =>
  (events: SseEvent[]): boolean =>
    events.some((event) => event.event === name);

async function fired(name: string): Promise<number | undefined> {
  return (await server.faults()).find((fault) => fault.name === name)?.fired;
}

/** The position and reach a copy stream announces once it is live. */
async function copyProof(): Promise<{ cursor: string; reach: string }> {
  const tap = await open({ query: COPY_QUERY });
  const events = await tap.until(named("stream_live"), "the copy stream live");
  const live = events.find((event) => event.event === "stream_live")!.data as {
    cursor: string;
    reach: string;
  };
  await tap.close();
  return live;
}

function incomplete(events: SseEvent[]): { reason: string; cursor: unknown } {
  const frame = events.find((event) => event.event === "stream_incomplete");
  expect(frame, "the stream did not say it was incomplete").toBeDefined();
  expect(frame!.id, "stream_incomplete carries an id").toBeUndefined();
  return frame!.data as { reason: string; cursor: unknown };
}

describe("a copy stream held after it reads the head of the log", () => {
  it("delivers what is written while it waits before it announces stream_live under the reach it opened with", async () => {
    await server.setFault("hold:stream-head");
    const tap = await open({ query: COPY_QUERY });
    await server.waitForHold("hold:stream-head");
    const written = await note("copy-written-while-held-at-the-head");
    await server.clearFault();

    const events = await tap.until(
      named("stream_live"),
      "the copy stream live",
    );
    const order = events.map((event) => event.event);
    expect(order[0]).toBe("stream_cursor");
    expect(order.at(-1)).toBe("stream_live");
    expect(events.filter(announces(written))).toHaveLength(1);
    const opening = events[0]!.data as { reach: string };
    const live = events.at(-1)!.data as { reach: string };
    expect(opening.reach).toMatch(/^[0-9a-f]{64}$/);
    expect(live.reach).toBe(opening.reach);
  });
});

describe("a stream whose read of the log fails", () => {
  it("ends a copy stream with stream_incomplete, and sends neither stream_cursor nor stream_live, when the read of the head fails", async () => {
    await server.setFault("fail:stream-head");
    const tap = await open({ query: COPY_QUERY });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(await fired("fail:stream-head")).toBe(1);

    // The same request, with the head readable, opens and goes live.
    const proof = await copyProof();
    expect(proof.reach).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends a copy stream's replay with read_failed when a read of the log fails", async () => {
    const proof = await copyProof();
    await note("copy-replay-read-fails");
    await server.setFault("fail:stream-replay");
    const tap = await open({
      query: COPY_QUERY,
      lastEventId: proof.cursor,
      reach: proof.reach,
    });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(await fired("fail:stream-replay")).toBe(1);
  });

  it("ends a copy stream's replay with read_failed when its credential cannot be read", async () => {
    const proof = await copyProof();
    await note("copy-replay-credential-fails");
    await server.setFault("fail:stream-credential");
    const tap = await open({
      query: COPY_QUERY,
      lastEventId: proof.cursor,
      reach: proof.reach,
    });
    await tap.untilClosed();
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(await fired("fail:stream-credential")).toBe(1);
  });
});

describe("a live stream that cannot go on delivering", () => {
  it("ends a copy stream with read_failed when the read of its credential before a batch fails", async () => {
    const tap = await open({ query: COPY_QUERY });
    await tap.until(named("stream_live"), "the copy stream live");
    await server.setFault("fail:stream-credential");
    await note("copy-live-credential-fails");
    await tap.untilClosed();
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(await fired("fail:stream-credential")).toBe(1);
  });
});
