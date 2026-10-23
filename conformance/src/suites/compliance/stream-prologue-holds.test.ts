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
  itemIdOf,
  streamHead,
  tapStream,
  type StreamTap,
} from "../../utils/stream-tap.js";

/**
 * What a stream does with the frames published while it opens: the ones it
 * holds until its replay and its final drain have run. The fixtures hold the
 * stream at its replay or at its drain (`hold:stream-replay`,
 * `hold:stream-drain`) and a write's announcement after its commit
 * (`hold:announce`), write while it waits, and let it go.
 *
 * A server of its own, so a stream sees only what the case wrote. The case
 * that moves the clock is last.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

let server: FreshServer;
let working: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("stream-prologue-holds");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
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

let serial = 0;
async function note(label: string, by = working): Promise<string> {
  serial += 1;
  const created = await by.createItem({
    type: "core.note",
    properties: { body: `${label}-${String(serial)}` },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

async function task(label: string): Promise<string> {
  serial += 1;
  const created = await working.createItem({
    type: "core.task",
    properties: { title: `${label}-${String(serial)}` },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

async function notes(count: number, label: string): Promise<string[]> {
  const made = await working.bulkItems({
    atomic: true,
    items: Array.from({ length: count }, (_, index) => ({
      type: "core.note",
      properties: { body: `${label}-${String(index)}` },
    })),
  });
  expect(made.status).toBe(200);
  return made.data.results.map((entry) => entry.id!);
}

/** A key that reads these types and nothing else, and the id to change it by. */
async function viewer(
  label: string,
  types: string[],
): Promise<{ id: string; key: string; reads(types: string[]): Promise<void> }> {
  const minted = await working.createKey({
    label,
    source: `stream-prologue-${label}`,
    permissions: [],
    type_permissions: Object.fromEntries(types.map((t) => [t, "read"])),
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  return {
    id: minted.data.id,
    key: minted.data.key,
    async reads(next) {
      const changed = await working.updateKey(minted.data.id, {
        type_permissions: Object.fromEntries(next.map((t) => [t, "read"])),
      });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    },
  };
}

const named =
  (name: string) =>
  (events: SseEvent[]): boolean =>
    events.some((event) => event.event === name);

/** The event id of the frame announcing `item` on a stream that reads everything. */
async function eventIdOf(observer: StreamTap, item: string): Promise<bigint> {
  const events = await observer.until(
    (seen) => seen.some(announces(item)),
    `the event for ${item} on the observing stream`,
  );
  return BigInt(events.find(announces(item))!.id!);
}

/** Opens a stream that reads everything and waits until it is live. */
async function observe(): Promise<StreamTap> {
  const observer = await open();
  await observer.until(named("stream_live"), "the observing stream live");
  return observer;
}

const countOf = (events: SseEvent[], item: string): number =>
  events.filter(announces(item)).length;

const live = (events: SseEvent[]): { cursor: string | null } =>
  events.find((event) => event.event === "stream_live")!.data as {
    cursor: string | null;
  };

describe("the final drain of a stream's held frames", () => {
  it("gives stream_live a cursor at or past a drained frame the credential withholds", async () => {
    const reader = await viewer("drain-cursor", ["core.note"]);
    const observer = await observe();
    await server.setFault("hold:stream-drain");
    const tap = await open({}, reader.key);
    await server.waitForHold("hold:stream-drain");

    const withheld = await task("drain-withheld");
    const eventId = await eventIdOf(observer, withheld);
    await server.clearFault("hold:stream-drain");

    const events = await tap.until(named("stream_live"), "the drain done");
    const head = BigInt(
      (
        events.find((event) => event.event === "stream_cursor")!.data as {
          cursor: string;
        }
      ).cursor,
    );
    // The witness: the frame is above the head the stream announced, so the
    // announcement cannot be what covers it.
    expect(eventId).toBeGreaterThan(head);
    expect(BigInt(live(events).cursor!)).toBeGreaterThanOrEqual(eventId);
    expect(events.some(announces(withheld))).toBe(false);
  });

  it("judges a frame held across a widening of the credential by the credential at the drain", async () => {
    const reader = await viewer("drain-widens", ["core.note"]);
    const observer = await observe();
    await server.setFault("hold:stream-drain");
    const tap = await open({}, reader.key);
    await server.waitForHold("hold:stream-drain");

    const widened = await task("drain-widened");
    await eventIdOf(observer, widened);
    await reader.reads(["core.note", "core.task"]);
    await server.clearFault("hold:stream-drain");

    const events = await tap.until(named("stream_live"), "the drain done");
    expect(countOf(events, widened)).toBe(1);
    const order = events.map((event) => event.event);
    expect(order.indexOf("item.created")).toBeLessThan(
      order.indexOf("stream_live"),
    );
  });

  it("judges a frame held across a narrowing of the credential by the credential at the drain", async () => {
    const reader = await viewer("drain-narrows", ["core.note", "core.task"]);
    const observer = await observe();
    await server.setFault("hold:stream-drain");
    const tap = await open({}, reader.key);
    await server.waitForHold("hold:stream-drain");

    const narrowed = await task("drain-narrowed");
    await eventIdOf(observer, narrowed);
    await reader.reads(["core.note"]);
    await server.clearFault("hold:stream-drain");

    // A frame written after the drain settles the absence: frames arrive in
    // id order, so the sentinel's arrival means the held one was judged.
    const sentinel = await note("drain-narrowed-sentinel");
    const events = await tap.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the drain`,
    );
    expect(events.some(announces(narrowed))).toBe(false);
  });
});

describe("the replay of a stream", () => {
  it("judges a frame a replay consumes by the credential at the replay", async () => {
    const reader = await viewer("replay-widens", ["core.note"]);
    const before = await streamHead(server.apiUrl, server.workingKey);
    const observer = await observe();
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");

    const widened = await task("replay-widened");
    await eventIdOf(observer, widened);
    await reader.reads(["core.note", "core.task"]);
    await server.clearFault("hold:stream-replay");

    const events = await tap.until(named("stream_live"), "the replay done");
    // Once, by the replay: its live twin is suppressed.
    expect(countOf(events, widened)).toBe(1);
    expect(events.find(announces(widened))!.id).toBeDefined();
  });

  it("suppresses the live twin of an event the replay withheld, after the credential widens", async () => {
    const reader = await viewer("replay-consumed", ["core.note"]);
    const before = await streamHead(server.apiUrl, server.workingKey);
    const observer = await observe();
    await server.setFault("hold:stream-replay");
    await server.setFault("hold:stream-drain");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");

    const withheld = await task("replay-withheld");
    await eventIdOf(observer, withheld);
    await server.clearFault("hold:stream-replay");
    // The replay has judged the event and withheld it; the drain has not run.
    await server.waitForHold("hold:stream-drain");
    await reader.reads(["core.note", "core.task"]);
    await server.clearFault("hold:stream-drain");

    const sentinel = await note("replay-withheld-sentinel");
    const events = await tap.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the drain`,
    );
    // The witness that the credential did widen: the same key reads a task
    // written from here on.
    const visible = await task("replay-withheld-visible");
    await tap.until(
      (seen) => seen.some(announces(visible)),
      `the task ${visible} the widened key may read`,
    );
    expect(events.some(announces(withheld))).toBe(false);
  });

  it("sends an event the replay sent once", async () => {
    const reader = await viewer("replay-sent", ["core.note"]);
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");
    const sent = await note("replay-sent");
    await server.clearFault("hold:stream-replay");

    const sentinel = await note("replay-sent-sentinel");
    const events = await tap.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the replay`,
    );
    expect(countOf(events, sent)).toBe(1);
  });

  it("sends an unreadable row's live copy after the replay, behind higher ids", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const observer = await observe();
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before });
    await server.waitForHold("hold:stream-replay");

    const unreadable = await note("unreadable");
    const readable = await note("readable-after");
    const unreadableId = await eventIdOf(observer, unreadable);
    const readableId = await eventIdOf(observer, readable);
    expect(unreadableId).toBeLessThan(readableId);
    await server.setFault("fail:stream-replay-row");
    await server.clearFault("hold:stream-replay");

    const events = await tap.until(named("stream_live"), "the prologue done");
    const sent = events.filter((event) => event.id !== undefined);
    expect(sent.map((event) => itemIdOf(event))).toEqual([
      readable,
      unreadable,
    ]);
    expect(sent.map((event) => BigInt(event.id!))).toEqual([
      readableId,
      unreadableId,
    ]);
    const order = events.map((event) => event.event);
    expect(order.lastIndexOf("item.created")).toBeLessThan(
      order.indexOf("stream_live"),
    );

    expect(await server.faults()).toContainEqual(
      expect.objectContaining({
        name: "fail:stream-replay-row",
        fired: 1,
      }),
    );
    // The fault affects a read, not the stored row: arm it again for a
    // replay with no live twin, then clear it to witness the intact row.
    await server.setFault("fail:stream-replay-row");
    const later = await open({ lastEventId: before });
    const replayed = await later.until(named("stream_live"), "the replay done");
    expect(replayed.some(announces(readable))).toBe(true);
    expect(replayed.some(announces(unreadable))).toBe(false);
    await server.clearFault("fail:stream-replay-row");
    const intact = await open({ lastEventId: before });
    const witnessed = await intact.until(
      named("stream_live"),
      "the intact replay done",
    );
    expect(witnessed.some(announces(unreadable))).toBe(true);
  });
});

describe("a write announced after its commit", () => {
  it("is not sent again to a stream that opened between the commit and the announcement", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:announce");
    const written = await note("committed-unannounced");

    const replayed = await open({ lastEventId: before });
    const fresh = await open();
    const replayEvents = await replayed.until(
      named("stream_live"),
      "the replaying stream live",
    );
    const freshEvents = await fresh.until(
      named("stream_live"),
      "the fresh stream live",
    );
    // The witness: the commit was visible to both streams when they opened.
    expect(countOf(replayEvents, written)).toBe(1);
    expect(countOf(freshEvents, written)).toBe(0);
    const writtenId = BigInt(replayEvents.find(announces(written))!.id!);
    expect(BigInt(live(freshEvents).cursor!)).toBeGreaterThanOrEqual(writtenId);

    await server.clearFault("hold:announce");
    const sentinel = await note("announced-sentinel");
    const afterReplay = await replayed.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the announcement`,
    );
    const afterFresh = await fresh.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the announcement`,
    );
    expect(countOf(afterReplay, written)).toBe(1);
    expect(countOf(afterFresh, written)).toBe(0);
  });

  it("is not sent again to a copy stream that opened between the commit and the announcement", async () => {
    await server.setFault("hold:announce");
    const written = await note("copy-committed-unannounced");
    const copy = await open({ query: COPY_QUERY });
    const events = await copy.until(
      named("stream_live"),
      "the copy stream live",
    );
    await server.clearFault("hold:announce");
    const sentinel = await note("copy-announced-sentinel");
    const after = await copy.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the announcement`,
    );
    expect(countOf(events, written)).toBe(0);
    expect(countOf(after, written)).toBe(0);
  });
});

describe("the frames a stream holds while it opens", () => {
  it("ends with backlog_overflow when more than 500 selected frames wait and no replay is reading", async () => {
    await server.setFault("hold:stream-drain");
    const tap = await open();
    await server.waitForHold("hold:stream-drain");
    await notes(501, "overflow");
    await server.clearFault("hold:stream-drain");
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "stream_incomplete",
    ]);
    expect(tap.events.at(-1)!.data).toEqual({
      event_type: "stream_incomplete",
      reason: "backlog_overflow",
      cursor: null,
    });
  });

  it("holds exactly 500 frames without ending", async () => {
    await server.setFault("hold:stream-drain");
    const tap = await open();
    await server.waitForHold("hold:stream-drain");
    const ids = await notes(500, "boundary");
    await server.clearFault("hold:stream-drain");
    const events = await tap.until(named("stream_live"), "the drain done");
    expect(events.filter(announces(ids[0]!))).toHaveLength(1);
    expect(
      events.filter((event) => event.event === "item.created"),
    ).toHaveLength(500);
    expect(named("stream_incomplete")(events)).toBe(false);
  });

  it("ends with backlog_overflow when a row the replay reads is unreadable and its live copy was given up to the replay", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const observer = await observe();
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before });
    await server.waitForHold("hold:stream-replay");

    const ids = await notes(501, "overflow-unreadable");
    await eventIdOf(observer, ids[0]!);
    await eventIdOf(observer, ids[500]!);
    await server.setFault("fail:stream-replay-row");
    await server.clearFault("hold:stream-replay");

    await tap.untilClosed();
    expect(tap.events.at(-1)!.data).toMatchObject({
      reason: "backlog_overflow",
    });
    expect(named("stream_live")(tap.events)).toBe(false);
  });

  it("hands 501 selected frames to the replay without ending when every row is readable", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before });
    await server.waitForHold("hold:stream-replay");
    const ids = await notes(501, "overflow-readable");
    await server.clearFault("hold:stream-replay");
    const events = await tap.until(named("stream_live"), "the replay done");
    const created = events.filter((event) => event.event === "item.created");
    expect(created.map(itemIdOf)).toEqual(ids);
    expect(named("stream_incomplete")(events)).toBe(false);
  });
});

describe("a replay the retention sweep overtakes", () => {
  it("ends with catchup_too_old instead of replaying over the gap", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before });
    await server.waitForHold("hold:stream-replay");

    await note("retired-first");
    await note("retired-second");
    await server.advanceClock(31 * DAY_MS);
    const kept = await note("kept");
    const ran = await operator.runHousekeeping("event-log-cleanup");
    expect(ran.status, JSON.stringify(ran.error)).toBe(200);

    // The witness that the sweep retired the events the replay was to read.
    const probe = await open({ lastEventId: before });
    await probe.until(named("catchup_too_old"), "the sweep to have run");

    const keptId = await streamHead(server.apiUrl, server.workingKey);
    await server.clearFault("hold:stream-replay");
    await tap.untilClosed();
    expect(tap.events.map((event) => event.event)).toEqual([
      "stream_cursor",
      "catchup_too_old",
    ]);
    const refusal = tap.events.at(-1)!;
    expect(refusal.id).toBeUndefined();
    expect(refusal.data).toMatchObject({
      event_type: "catchup_too_old",
      min_retained_id: keptId,
      requested: before,
    });
    expect(tap.events.some(announces(kept))).toBe(false);
  });
});
