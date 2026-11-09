import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";
import type { SseEvent } from "../../utils/sse.js";
import {
  announces,
  streamHead,
  tapStream,
  type StreamTap,
} from "../../utils/stream-tap.js";

// The case that moves the clock runs last.

const DAY_MS = 24 * 60 * 60 * 1000;

let server: FreshServer;
let working: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("stream-prologue-holds", QUIET_SCHEDULE);
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

describe("a replay judges each page when it reads the page", () => {
  it("sends a frame the credential has come to read by the time its page is read", async () => {
    const reader = await viewer("page-widens", ["core.note"]);
    const before = await streamHead(server.apiUrl, server.workingKey);
    await note("page-widens-fodder");
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");

    const widened = await task("page-widened");
    await reader.reads(["core.note", "core.task"]);
    await server.clearFault("hold:stream-replay");

    const events = await tap.until(named("stream_live"), "the replay done");
    expect(countOf(events, widened)).toBe(1);
    expect(events.find(announces(widened))!.id).toBeDefined();
  });

  it("withholds a frame the credential has come to lose by the time its page is read, and covers it with stream_live", async () => {
    const reader = await viewer("page-narrows", ["core.note", "core.task"]);
    const observer = await observe();
    const before = await streamHead(server.apiUrl, server.workingKey);
    await note("page-narrows-fodder");
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");

    const narrowed = await task("page-narrowed");
    const eventId = await eventIdOf(observer, narrowed);
    await reader.reads(["core.note"]);
    await server.clearFault("hold:stream-replay");

    const events = await tap.until(named("stream_live"), "the replay done");
    expect(events.some(announces(narrowed))).toBe(false);
    expect(BigInt(live(events).cursor!)).toBeGreaterThanOrEqual(eventId);
  });

  it("withholds a frame the credential never read, and sends the key's readable frames after it", async () => {
    const reader = await viewer("page-withholds", ["core.note"]);
    const before = await streamHead(server.apiUrl, server.workingKey);
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before }, reader.key);
    await server.waitForHold("hold:stream-replay");
    const withheld = await task("page-withheld");
    const sent = await note("page-sent");
    await server.clearFault("hold:stream-replay");

    const events = await tap.until(
      (seen) => seen.some(announces(sent)),
      `the note ${sent} after the withheld task`,
    );
    expect(events.some(announces(withheld))).toBe(false);
  });
});

describe("a stream sends no id twice", () => {
  it("sends an event written while the replay waited once, and none at or below an id it has sent", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const fodder = await note("once-fodder");
    await server.setFault("hold:stream-replay");
    const tap = await open({ lastEventId: before });
    await server.waitForHold("hold:stream-replay");
    const sent = await note("once-written-while-held");
    await server.clearFault("hold:stream-replay");

    const sentinel = await note("once-sentinel");
    const events = await tap.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} after the replay`,
    );
    expect(countOf(events, fodder)).toBe(1);
    expect(countOf(events, sent)).toBe(1);
    const ids = events
      .filter((event) => event.id !== undefined)
      .map((event) => BigInt(event.id!));
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("does not send an event a stream opened between the commit and the next write again", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const written = await note("committed-before-open");

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
    expect(countOf(replayEvents, written)).toBe(1);
    expect(countOf(freshEvents, written)).toBe(0);
    const writtenId = BigInt(replayEvents.find(announces(written))!.id!);
    expect(BigInt(live(freshEvents).cursor!)).toBeGreaterThanOrEqual(writtenId);

    const sentinel = await note("after-open-sentinel");
    const afterReplay = await replayed.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} on the replaying stream`,
    );
    const afterFresh = await fresh.until(
      (seen) => seen.some(announces(sentinel)),
      `the note ${sentinel} on the fresh stream`,
    );
    expect(countOf(afterReplay, written)).toBe(1);
    expect(countOf(afterFresh, written)).toBe(0);
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
