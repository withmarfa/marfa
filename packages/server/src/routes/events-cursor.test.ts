/**
 * The stream says where it is before it says anything else.
 *
 * A client hydrating a durable store subscribes first and reads its
 * snapshot second, so that a write landing between the two arrives on the
 * stream rather than falling in the gap. That ordering only works if the
 * client holds a cursor at the moment it starts reading. Without one it
 * has nothing to resume from until an event happens to arrive, so on a
 * quiet space it can be interrupted after a full read and come back with
 * no way to ask what it missed — and no way to know that it missed
 * anything.
 *
 * So the first frame of every stream carries the log's current id.
 *
 * **It deliberately carries no `id:` field.** A resuming client is sent
 * this frame too, before its backlog, and SSE clients — the browser's
 * `EventSource` and this repository's own subscriber alike — treat `id:`
 * as the cursor to resume from next time. An announcement carrying one
 * would move a reconnecting client's cursor to the head of the log before
 * a single replayed event had been applied, discarding exactly the backlog
 * the reconnect existed to fetch. That is the one way this frame could
 * lose data, so it is asserted rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this nothing is appended: `publish` writes to the event log
  // only when one is installed, and the test context installs none.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * The newest id in the log, walked from the rows.
 *
 * Deliberately not `eventLog.getMaxId`, which is what the route asks:
 * a test whose oracle is the method under test agrees with it however
 * wrong both are.
 */
async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

async function createItem(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type, properties },
  });
  expect(res.status, `create ${type}`).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

function createNote(body: string): Promise<string> {
  return createItem("core.note", { body });
}

/** The raw text of the first frame whose `event:` field matches, or null. */
function frameNamed(sse: string, eventName: string): string | null {
  for (const frame of sse.split("\n\n")) {
    if (frame.split("\n").includes(`event: ${eventName}`)) return frame;
  }
  return null;
}

function dataOf(frame: string): Record<string, unknown> {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));
  if (line === undefined) throw new Error(`frame carried no data: ${frame}`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

/** Open a stream, read to its announcement, and close it again. */
async function announcedCursor(query = ""): Promise<string> {
  const res = await request(ctx.app, "GET", `/events${query}`, {
    key: ctx.spaceKey,
  });
  expect(res.status).toBe(200);
  const { text } = await readSse(res, {
    until: (t) => t.includes("event: stream_cursor"),
  });
  const frame = frameNamed(text, "stream_cursor");
  expect(frame, "the stream must announce a cursor on connect").not.toBeNull();
  const cursor = dataOf(frame ?? "").cursor;
  expect(
    typeof cursor,
    "the cursor must be a string the header can carry",
  ).toBe("string");
  // The stream this opened is finished with; let its cleanup run before
  // anything is written, so nothing below depends on a departed subscriber.
  await settle();
  return String(cursor);
}

describe("GET /events announces its cursor", () => {
  it("announces the head, and resuming from it delivers what came after it and nothing before", async () => {
    // Both directions in one assertion set, because a cursor is only
    // useful when it is exactly right: one too high skips the first thing
    // written after it, one too low re-sends what the client already had,
    // and either reads as working on a test that checks only the first.
    const before = await createNote("written before the connection");
    const head = await latestEventId();

    const cursor = await announcedCursor();
    expect(cursor, "the announcement must name the log's current head").toBe(
      String(head),
    );

    const missed = await createNote("written while nobody was listening");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.spaceKey,
      headers: { "Last-Event-ID": cursor },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, { until: (t) => t.includes(missed) });
    expect(
      text,
      "resuming from the announced cursor must deliver what was written after it",
    ).toContain(missed);
    expect(
      text,
      "resuming from the announced cursor must not re-send what was already behind it",
    ).not.toContain(before);
  });

  it("announces before it replays, and without an id of its own", async () => {
    await createNote("seed");
    const cursor = await latestEventId();
    const backlog = await createNote("written while the client was away");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.spaceKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(backlog),
    });

    const announcement = text.indexOf("event: stream_cursor");
    const firstItem = text.indexOf("event: item.created");
    expect(announcement, "the stream must announce a cursor").toBeGreaterThan(
      -1,
    );
    expect(
      announcement,
      "the announcement must arrive before the backlog it precedes",
    ).toBeLessThan(firstItem);

    const frame = frameNamed(text, "stream_cursor");
    expect(
      frame?.split("\n").some((l) => l.startsWith("id:")),
      "an id on the announcement would move a resuming client's cursor past its own backlog",
    ).toBe(false);
  });

  it("names a position in the log rather than in the filter, so a cursor survives a filter change", async () => {
    // The decision this pins: `event_log.id` is one ascending sequence and
    // the filters choose a subset of it, never a different order of it, so
    // a cursor is replayable under a filter it was not taken under.
    //
    // The stale write is what tells the two apart. It is the newest row in
    // the log and outside the filter the cursor is taken under, so a head
    // computed with that filter applied would land behind it — and the
    // unfiltered replay below would hand it back to a client that had
    // already seen it, with nothing anywhere saying so.
    const tag = `zz${Math.random().toString(36).slice(2, 8)}zz`;
    const stale = await createItem("core.task", { title: `${tag}stale` });

    const cursor = await announcedCursor("?type=core.note");

    const task = await createItem("core.task", { title: `${tag}task` });
    const note = await createNote(`${tag}note`);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.spaceKey,
      headers: { "Last-Event-ID": cursor },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, { until: (t) => t.includes(note) });

    expect(
      text,
      "a cursor taken under a filter must not sit behind rows the filter excluded",
    ).not.toContain(stale);
    expect(
      text,
      "replaying without the filter the cursor was taken under must deliver the rows it excluded",
    ).toContain(task);
    expect(text, "and the rows it admitted").toContain(note);
  });
});
