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
 * A copy stream is certified by the read view it opened under. A change to
 * that view while the stream replays, holds a frame, or is about to announce
 * `stream_live` ends it with `read_view_changed`, and nothing past the change
 * reaches it (`read-views/terminal-races`, `read-views/terminal-races-silent`).
 *
 * The fixtures hold the stream at its replay or its final drain
 * (`hold:stream-replay`, `hold:stream-drain`), narrow the key it reads with,
 * which changes its read view and publishes no event of its own, and let it
 * go. The same case with the key left alone ends live, which shows the stream
 * would have gone on.
 */

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("copy-stream-races");
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

let serial = 0;
async function note(label: string): Promise<string> {
  serial += 1;
  const created = await working.createItem({
    type: "core.note",
    properties: { body: `${label}-${String(serial)}` },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

/** A key that reads notes and tasks, and the means to narrow it to notes. */
async function reader(label: string): Promise<{
  key: string;
  narrow(): Promise<void>;
}> {
  const minted = await working.createKey({
    label,
    source: `copy-races-${label}`,
    permissions: [],
    type_permissions: { "core.note": "read", "core.task": "read" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  return {
    key: minted.data.key,
    async narrow() {
      const changed = await working.updateKey(minted.data.id, {
        type_permissions: { "core.note": "read" },
      });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    },
  };
}

async function open(
  key: string,
  options: Parameters<typeof tapStream>[2] = {},
): Promise<StreamTap> {
  const tap = await tapStream(server.apiUrl, key, {
    query: COPY_QUERY,
    ...options,
  });
  taps.push(tap);
  return tap;
}

const named =
  (name: string) =>
  (events: SseEvent[]): boolean =>
    events.some((event) => event.event === name);

async function proofFor(
  key: string,
): Promise<{ cursor: string; read_view: string }> {
  const tap = await open(key);
  const events = await tap.until(named("stream_live"), "the copy stream live");
  await tap.close();
  return events.find((event) => event.event === "stream_live")!.data as {
    cursor: string;
    read_view: string;
  };
}

function expectChanged(tap: StreamTap): void {
  expect(tap.events.map((event) => event.event)).toEqual([
    "stream_cursor",
    "read_view_changed",
  ]);
  const terminal = tap.events.at(-1)!;
  expect(terminal.id).toBeUndefined();
  expect(terminal.data).toEqual({ event_type: "read_view_changed" });
}

describe("a copy stream replaying when its read view changes", () => {
  it("ends with read_view_changed and sends no replayed frame and no stream_live", async () => {
    const who = await reader("replay-race");
    const proof = await proofFor(who.key);
    const replayable = await note("replayable");
    await server.setFault("hold:stream-replay");
    const tap = await open(who.key, {
      lastEventId: proof.cursor,
      readView: proof.read_view,
    });
    await server.waitForHold("hold:stream-replay");
    await who.narrow();
    await server.clearFault("hold:stream-replay");
    await tap.untilClosed();
    expectChanged(tap);
    expect(tap.events.some(announces(replayable))).toBe(false);
  });

  it("goes live when the view does not change, which shows the replay would have gone on", async () => {
    const who = await reader("replay-no-race");
    const proof = await proofFor(who.key);
    const replayable = await note("replayable-unchanged");
    await server.setFault("hold:stream-replay");
    const tap = await open(who.key, {
      lastEventId: proof.cursor,
      readView: proof.read_view,
    });
    await server.waitForHold("hold:stream-replay");
    await server.clearFault("hold:stream-replay");
    const events = await tap.until(named("stream_live"), "the stream live");
    expect(events.some(announces(replayable))).toBe(true);
  });
});

describe("a copy stream holding a frame when its read view changes", () => {
  it("ends with read_view_changed and sends neither the held frame nor stream_live", async () => {
    const who = await reader("hold-race");
    await server.setFault("hold:stream-drain");
    const tap = await open(who.key);
    await server.waitForHold("hold:stream-drain");
    const held = await note("held-frame");
    // The frame reaches the stream's hold before the view changes, so the
    // end is the drain's to decide and not the arrival of a frame's.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await who.narrow();
    await server.clearFault("hold:stream-drain");
    await tap.untilClosed();
    expectChanged(tap);
    expect(tap.events.some(announces(held))).toBe(false);
  });

  it("sends the held frame and goes live when the view does not change", async () => {
    const who = await reader("hold-no-race");
    await server.setFault("hold:stream-drain");
    const tap = await open(who.key);
    await server.waitForHold("hold:stream-drain");
    const held = await note("held-frame-unchanged");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await server.clearFault("hold:stream-drain");
    const events = await tap.until(named("stream_live"), "the stream live");
    expect(events.some(announces(held))).toBe(true);
  });
});

describe("a copy stream about to announce stream_live when its read view changes", () => {
  it("ends with read_view_changed and does not announce stream_live", async () => {
    const who = await reader("announce-race");
    await server.setFault("hold:stream-drain");
    const tap = await open(who.key);
    await server.waitForHold("hold:stream-drain");
    await who.narrow();
    await server.clearFault("hold:stream-drain");
    await tap.untilClosed();
    expectChanged(tap);
  });
});
