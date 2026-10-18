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

/**
 * What an event stream does when the server cannot read what it needs to
 * open, to replay, or to go on delivering: the head of the log, a page of the
 * log, the stream's credential, or the commit of a write whose events the
 * stream waits for.
 *
 * The fixtures set the failure or the hold through the target interface
 * (`conformance/README.md`, "Faults") on a server of their own. A fault acts
 * once, so each case ends by showing that the same request succeeds with the
 * fault spent: the stream failed because of the fault and not because of the
 * request.
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

/** The position and read view a copy stream announces once it is live. */
async function copyProof(): Promise<{ cursor: string; read_view: string }> {
  const tap = await open({ query: COPY_QUERY });
  const events = await tap.until(named("stream_live"), "the copy stream live");
  const live = events.find((event) => event.event === "stream_live")!.data as {
    cursor: string;
    read_view: string;
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

describe("a stream that cannot read the head of the log within its budget", () => {
  it("sends stream_live with a null cursor when it has read and sent no event", async () => {
    await server.setFault("hold:stream-head");
    const tap = await open();
    await server.waitForHold("hold:stream-head");
    const events = await tap.until(
      named("stream_live"),
      "stream_live after the head read outran its budget",
      20_000,
    );
    const live = events.find((event) => event.event === "stream_live")!;
    expect(live.data).toEqual({ event_type: "stream_live", cursor: null });
    expect(live.id).toBeUndefined();
    expect(
      events.some((event) => event.event === "stream_cursor"),
      "the stream announced a head it never read",
    ).toBe(false);

    // The stream carries on: a write reaches it.
    await server.clearFault();
    const written = await note("after-unknown-head");
    await tap.until(
      (seen) => seen.some(announces(written)),
      `the note ${written} on the stream`,
    );
  });

  it("names the furthest event it replayed instead when it read one", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const replayed = await note("replayed-with-unknown-head");
    await server.setFault("hold:stream-head");
    const tap = await open({ lastEventId: before });
    const events = await tap.until(
      named("stream_live"),
      "stream_live after the head read outran its budget",
      20_000,
    );
    expect(events.some(announces(replayed))).toBe(true);
    const live = events.find((event) => event.event === "stream_live")!;
    const cursor = (live.data as { cursor: string | null }).cursor;
    expect(cursor).not.toBeNull();
    expect(BigInt(cursor!)).toBeGreaterThanOrEqual(
      BigInt(events.find(announces(replayed))!.id!),
    );
  });

  it("ends a copy stream with stream_incomplete, and sends neither stream_cursor nor stream_live", async () => {
    await server.setFault("hold:stream-head");
    const tap = await open({ query: COPY_QUERY });
    await server.waitForHold("hold:stream-head");
    await tap.untilClosed(20_000);
    expect(tap.status).toBe(200);
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_incomplete",
    ]);
    incomplete(tap.events);

    // The same request, with the head readable, opens and goes live.
    await server.clearFault();
    const proof = await copyProof();
    expect(proof.read_view).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a stream whose read of the log fails", () => {
  it("ends with replay_failed when the read of the head fails as it opens", async () => {
    await server.setFault("fail:stream-head");
    const tap = await open();
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events)).toEqual({
      event_type: "stream_incomplete",
      reason: "replay_failed",
      cursor: null,
    });
    expect(await fired("fail:stream-head")).toBe(1);

    const again = await open();
    await again.until(named("stream_live"), "the same stream live");
  });

  it("ends a copy stream's opening with replay_failed when the read of the head fails", async () => {
    await server.setFault("fail:stream-head");
    const tap = await open({ query: COPY_QUERY });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("replay_failed");
    expect(await fired("fail:stream-head")).toBe(1);
    await copyProof();
  });

  it("ends with replay_failed when a read of the log fails while it replays, naming the last event it sent", async () => {
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
      reason: "replay_failed",
      cursor: null,
    });
    expect(await fired("fail:stream-replay")).toBe(1);

    // The cursor is good: the stream resumed from it replays the row.
    const again = await open({ lastEventId: before });
    const events = await again.until(named("stream_live"), "the replay done");
    expect(events.some((event) => event.event === "item.created")).toBe(true);
  });

  it("ends a copy stream's replay with replay_failed when a read of the log fails", async () => {
    const proof = await copyProof();
    await note("copy-replay-read-fails");
    await server.setFault("fail:stream-replay");
    const tap = await open({
      query: COPY_QUERY,
      lastEventId: proof.cursor,
      readView: proof.read_view,
    });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("replay_failed");
    expect(await fired("fail:stream-replay")).toBe(1);
  });

  it("ends with replay_failed when the read of its credential before a page of the replay fails", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await note("replay-credential-fails");
    await server.setFault("fail:stream-credential");
    const tap = await open({ lastEventId: before });
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(incomplete(tap.events).reason).toBe("replay_failed");
    expect(await fired("fail:stream-credential")).toBe(1);

    const again = await open({ lastEventId: before });
    const events = await again.until(named("stream_live"), "the replay done");
    expect(events.some((event) => event.event === "item.created")).toBe(true);
  });

  it("ends a copy stream's replay with replay_failed when its credential cannot be read", async () => {
    const proof = await copyProof();
    await note("copy-replay-credential-fails");
    await server.setFault("fail:stream-credential");
    const tap = await open({
      query: COPY_QUERY,
      lastEventId: proof.cursor,
      readView: proof.read_view,
    });
    await tap.untilClosed();
    expect(incomplete(tap.events).reason).toBe("replay_failed");
    expect(await fired("fail:stream-credential")).toBe(1);
  });
});

describe("a live stream that cannot go on delivering", () => {
  it("ends with live_delivery_failed when the read of its credential before a batch fails", async () => {
    const tap = await open();
    await tap.until(named("stream_live"), "the stream live");
    await server.setFault("fail:stream-credential");
    const sent = await note("live-credential-fails");
    await tap.untilClosed();
    expect(incomplete(tap.events)).toEqual({
      event_type: "stream_incomplete",
      reason: "live_delivery_failed",
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

  it("ends a copy stream with live_delivery_failed when the read of its credential before a batch fails", async () => {
    const tap = await open({ query: COPY_QUERY });
    await tap.until(named("stream_live"), "the copy stream live");
    await server.setFault("fail:stream-credential");
    await note("copy-live-credential-fails");
    await tap.untilClosed();
    expect(incomplete(tap.events).reason).toBe("live_delivery_failed");
    expect(await fired("fail:stream-credential")).toBe(1);
  });

  it("ends with live_delivery_failed when the read of its credential at a heartbeat fails", async () => {
    const tap = await open();
    await tap.until(named("stream_live"), "the stream live");
    await server.setFault("fail:stream-credential");
    // Nothing is written: only the heartbeat reads the credential.
    await tap.untilClosed(45_000);
    expect(incomplete(tap.events).reason).toBe("live_delivery_failed");
    expect(
      tap.events.filter((event) => event.event !== "stream_incomplete"),
    ).toHaveLength(2);
    expect(await fired("fail:stream-credential")).toBe(1);
  }, 60_000);

  it("ends every stream with live_delivery_failed when the server cannot confirm a commit whose events they wait for", async () => {
    const first = await open();
    const second = await open({ query: COPY_QUERY });
    await first.until(named("stream_live"), "the stream live");
    await second.until(named("stream_live"), "the copy stream live");

    await server.setFault("fail:commit=item.create");
    const refused = await working.createItem({
      type: "core.note",
      properties: { body: "commit-unknown" },
    });
    // The witness that the fault acted on this write and left its outcome unknown.
    expect(refused.ok).toBe(false);
    expect(await fired("fail:commit")).toBe(1);

    await Promise.all([first.untilClosed(), second.untilClosed()]);
    expect(incomplete(first.events).reason).toBe("live_delivery_failed");
    expect(incomplete(second.events).reason).toBe("live_delivery_failed");
  });
});
