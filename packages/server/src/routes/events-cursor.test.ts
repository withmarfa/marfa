/**
 * The stream says where it is before it says anything else.
 *
 * A client hydrating a durable store subscribes first and reads its
 * snapshot second, so that a write landing between the two arrives on the
 * stream rather than falling in the gap. That ordering only works if the
 * client holds a cursor at the moment it starts reading. Without one it
 * has nothing to resume from until an event happens to arrive, so on a
 * quiet instance it can be interrupted after a full read and come back with
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
import {
  createTestContext,
  readSse,
  readSseWriting,
  request,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import type { PersistedEvent } from "../storage/interface.js";

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
    key: ctx.workingKey,
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

/**
 * Park the replay's first log read until `open()`, after the head has been
 * announced, and hand back the rows that read returned once it has run.
 *
 * `rows` is the guard: a read that ran before the writes it was meant to
 * walk would come back short, and the test would pass having exercised
 * none of its own arrangement.
 */
function gateFirstReplayRead(): {
  reached: Promise<void>;
  open: () => void;
  rows: Promise<PersistedEvent[]>;
  restore: () => void;
} {
  const store = ctx.storage.eventLog;
  const real = store.getAfter.bind(store);
  let arrive: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen: (rows: PersistedEvent[]) => void = () => undefined;
  const rows = new Promise<PersistedEvent[]>((resolve) => {
    seen = resolve;
  });
  let armed = true;
  store.getAfter = async (afterId, limit) => {
    if (!armed) return real(afterId, limit);
    armed = false;
    arrive();
    await opened;
    const batch = await real(afterId, limit);
    seen(batch);
    return batch;
  };
  return {
    reached,
    open: () => {
      release();
    },
    rows,
    restore: () => {
      store.getAfter = real;
    },
  };
}

/** Open a stream, read to its announcement, and close it again. */
async function announcedCursor(query = ""): Promise<string> {
  const res = await request(ctx.app, "GET", `/events${query}`, {
    key: ctx.workingKey,
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
      key: ctx.workingKey,
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
      key: ctx.workingKey,
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
      key: ctx.workingKey,
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

describe("GET /events says when it is live", () => {
  it("sends stream_live after the replay and before anything live, without an id, at the head", async () => {
    await createNote("seed");
    const cursor = await latestEventId();
    const backlog = await createNote("written while the client was away");
    const head = await latestEventId();

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    // Written once the marker has arrived, so its frame is a live one and
    // the marker's place before it is an observation.
    let live: string | undefined;
    const { text } = await readSseWriting(
      res,
      "event: stream_live",
      async () => {
        live = await createNote("written once the stream was live");
      },
      (seen) => seen.includes("written once the stream was live"),
    );

    const marker = frameNamed(text, "stream_live");
    expect(marker, "the stream must say when it is live").not.toBeNull();
    expect(
      marker?.split("\n").some((l) => l.startsWith("id:")),
      "an id on the marker would move a resuming client's cursor",
    ).toBe(false);
    expect(dataOf(marker ?? "").cursor).toBe(String(head));
    const at = text.indexOf("event: stream_live");
    expect(at).toBeGreaterThan(text.indexOf(backlog));
    expect(at).toBeLessThan(text.indexOf(live!));
    // Once. A second marker would name a position past frames the
    // client has already been sent, and a client that treats the marker
    // as the end of its replay would treat the frames between as replay.
    expect(text.split("event: stream_live").length - 1).toBe(1);
  });

  it("names the head, not the cursor, when the client resumes from above the head", async () => {
    // A client whose cursor came from elsewhere, or from a log since
    // rebuilt, can ask to resume from an id the log has not reached. The
    // marker covers what the stream has sent or withheld, and that is the
    // head: a marker naming the client's own cursor would have it skip
    // every id up to there on its next replay, and the live frames below
    // it follow the marker as the proof that they were not covered.
    await createNote("seed");
    const head = await latestEventId();

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(head + 1000n) },
    });
    expect(res.status).toBe(200);
    let live: string | undefined;
    const { text } = await readSseWriting(
      res,
      "event: stream_live",
      async () => {
        live = await createNote("written below the client's cursor");
      },
      (seen) => seen.includes("written below the client's cursor"),
    );

    expect(dataOf(frameNamed(text, "stream_live") ?? "").cursor).toBe(
      String(head),
    );
    const at = text.indexOf("event: stream_live");
    expect(at).toBeLessThan(text.indexOf(live!));
    const liveId = /^id: (\d+)$/m.exec(text.slice(at))?.[1];
    expect(liveId).toBeDefined();
    expect(BigInt(liveId!) > head).toBe(true);
    expect(BigInt(liveId!) < head + 1000n).toBe(true);
  });

  it("names the last row the replay walked, past the head, when every row past it was withheld", async () => {
    // The head is read before the replay, so rows written between the two
    // are walked by the replay and lie past the head. When the filter
    // withholds every one of them nothing is sent, and the marker still
    // has to name the last of them: a client resuming from the head
    // would have them walked, and withheld, again.
    await createNote("seed");
    const cursor = await latestEventId();
    await createItem("core.bookmark", { url: "https://example.com/walked" });
    const head = await latestEventId();

    const gate = gateFirstReplayRead();
    try {
      const res = await request(ctx.app, "GET", "/events?type=core.bookmark", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      expect(res.status).toBe(200);
      await gate.reached;
      // Past the head the stream announced, and withheld by its filter.
      const first = await createNote("walked and withheld");
      const last = await createNote("walked and withheld, last");
      const walkedTo = await latestEventId();
      expect(walkedTo > head).toBe(true);
      gate.open();

      const { text } = await readSse(res, {
        until: (t) => t.includes("event: stream_live"),
      });
      // The gated read is what walked the rows, or the arrangement
      // proved nothing.
      const walked = (await gate.rows).map((row) => row.id);
      expect(walked).toContain(walkedTo);
      expect(text).not.toContain(first);
      expect(text).not.toContain(last);
      expect(dataOf(frameNamed(text, "stream_cursor") ?? "").cursor).toBe(
        String(head),
      );
      expect(dataOf(frameNamed(text, "stream_live") ?? "").cursor).toBe(
        String(walkedTo),
      );
    } finally {
      gate.restore();
    }
  });

  it("names the head even when the frame that reached it is withheld from this stream", async () => {
    await createNote("seed");
    const cursor = await latestEventId();
    const bookmark = await createItem("core.bookmark", {
      url: "https://example.com/head",
    });
    // The head is a note, which a stream narrowed to bookmarks is never
    // sent; the marker names it all the same, and nothing else could.
    const note = await createNote("the head");
    const head = await latestEventId();

    const res = await request(ctx.app, "GET", "/events?type=core.bookmark", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes("event: stream_live"),
    });
    expect(text).toContain(bookmark);
    expect(text).not.toContain(note);
    expect(dataOf(frameNamed(text, "stream_live") ?? "").cursor).toBe(
      String(head),
    );
  });
});

describe("the event cursor is compared as the integer it is", () => {
  it("does not round a cursor above 2^53 down onto the row it was told to resume after", async () => {
    // A row id past the double's exact range. Compared through `Number()`,
    // a cursor of 2^53 + 1 rounds to 2^53 and the read would repeat the row
    // it was told to resume after. Only the exclusion is asserted: the
    // driver reads an INTEGER as a JS number and refuses one it cannot
    // represent, so a read that matched the row would throw rather than
    // return it, which is also what the rounding comparison does here.
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    const id = 2n ** 53n + 1n;
    await s.__sqliteRun(
      "INSERT INTO event_log (id, event_type, item_id, payload, enable_fanout, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      [
        id.toString(),
        "created",
        "item-past-2-53",
        "{}",
        new Date().toISOString(),
      ],
    );
    try {
      const none = await ctx.storage.eventLog.getAfter(id, 10);
      expect(none).toEqual([]);
    } finally {
      await s.__sqliteRun("DELETE FROM event_log WHERE id = ?", [
        id.toString(),
      ]);
    }
  });
});
