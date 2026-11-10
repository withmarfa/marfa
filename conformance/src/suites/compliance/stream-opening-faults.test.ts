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
  streamHead,
  tapStream,
  type StreamTap,
} from "../../utils/stream-tap.js";

// Failure faults act once; hold faults stay armed until cleared.

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

function incomplete(events: SseEvent[]): { reason: string; cursor: unknown } {
  const frame = events.find((event) => event.event === "stream_incomplete");
  expect(frame, "the stream did not say it was incomplete").toBeDefined();
  expect(frame!.id, "stream_incomplete carries an id").toBeUndefined();
  return frame!.data as { reason: string; cursor: unknown };
}

describe("a stream held after it reads the head of the log", () => {
  it("announces the head it read and delivers what is written while it waits", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:stream-head");
    const tap = await open();
    await server.waitForHold("hold:stream-head");
    const written = await note("written-while-held-at-the-head");
    await server.clearFault();

    const events = await tap.until(
      (seen) => seen.some(announces(written)),
      `the note ${written} after the hold`,
    );
    const order = events.map((event) => event.event);
    expect(order.slice(0, 2)).toEqual(["stream_cursor", "stream_live"]);
    expect(events[0]!.data).toEqual({
      event_type: "stream_cursor",
      cursor: before,
    });
    expect(events.filter(announces(written))).toHaveLength(1);
  });
});

describe("a stream whose read of the log fails", () => {
  it("ends with read_failed when the read of the head fails as it opens", async () => {
    await server.setFault("fail:stream-head");
    const tap = await open();
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events)).toEqual({
      event_type: "stream_incomplete",
      reason: "read_failed",
      cursor: null,
    });
    expect(await fired("fail:stream-head")).toBe(1);

    const again = await open();
    await again.until(named("stream_live"), "the same stream live");
  });

  it("ends with read_failed and a null cursor when the first replay page fails", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await note("replay-read-fails");
    await server.setFault("fail:stream-replay");
    const tap = await open({ lastEventId: before });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events)).toEqual({
      event_type: "stream_incomplete",
      reason: "read_failed",
      cursor: null,
    });
    expect(await fired("fail:stream-replay")).toBe(1);

    // The cursor is good: the stream resumed from it replays the item.
    const again = await open({ lastEventId: before });
    const events = await again.until(named("stream_live"), "the replay done");
    expect(events.some((event) => event.event === "item.created")).toBe(true);
  });

  it("ends with read_failed when the read of its credential before a page of the replay fails", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await note("replay-credential-fails");
    await server.setFault("fail:stream-credential");
    const tap = await open({ lastEventId: before });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(await fired("fail:stream-credential")).toBe(1);

    const again = await open({ lastEventId: before });
    const events = await again.until(named("stream_live"), "the replay done");
    expect(events.some((event) => event.event === "item.created")).toBe(true);
  });
});

describe("a live stream that cannot go on delivering", () => {
  it("ends with read_failed when the read of its credential before a batch fails", async () => {
    const tap = await open();
    await tap.until(named("stream_live"), "the stream live");
    await server.setFault("fail:stream-credential");
    const sent = await note("live-credential-fails");
    await tap.untilClosed();
    expect(incomplete(tap.events)).toEqual({
      event_type: "stream_incomplete",
      reason: "read_failed",
      cursor: null,
    });
    expect(tap.events.some(announces(sent))).toBe(false);
    expect(await fired("fail:stream-credential")).toBe(1);

    // The frame the stream did not deliver is in the log behind its cursor.
    const head = await streamHead(server.apiUrl, server.workingKey);
    const again = await open({ lastEventId: String(BigInt(head) - 1n) });
    const events = await again.until(named("stream_live"), "the replay done");
    expect(events.some(announces(sent))).toBe(true);
  });

  it("ends with read_failed when the read of its credential at a heartbeat fails", async () => {
    const tap = await open();
    await tap.until(named("stream_live"), "the stream live");
    await server.setFault("fail:stream-credential");
    // Nothing is written: only the heartbeat reads the credential.
    await tap.untilClosed(45_000);
    expect(incomplete(tap.events).reason).toBe("read_failed");
    expect(
      tap.events.filter((event) => event.event !== "stream_incomplete"),
    ).toHaveLength(2);
    expect(await fired("fail:stream-credential")).toBe(1);
  }, 60_000);
});
