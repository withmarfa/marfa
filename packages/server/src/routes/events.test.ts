import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, readSse, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import { parseEventLogRetentionHours } from "../config.js";
import { eventLog } from "../storage/sqlite/schema.js";

// Enable event_log persistence for the whole suite. The default test
// bootstrap leaves it unwired; we need `publish()` to append so the
// replay-cursor logic has rows to reason about.
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

interface CreatedItem {
  item: { id: string; type: string };
}

function maxBigInt(values: bigint[]): bigint {
  return values.reduce((a, b) => (a > b ? a : b), 0n);
}

async function createNote(body = "hello"): Promise<bigint> {
  // Returns the event_log id appended for this create. We read it
  // straight off storage because POST /items doesn't echo the event id.
  const before = await ctx.storage.eventLog.getAfter(0n, 1000);
  const maxBefore = before.length ? maxBigInt(before.map((e) => e.id)) : 0n;
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  (await res.json()) as CreatedItem;
  const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
  expect(after.length).toBeGreaterThan(0);
  return maxBigInt(after.map((e) => e.id));
}

/** Parse an SSE frame looking for a named event. */
function findEvent(
  sse: string,
  eventName: string,
): { id?: string; data: string } | null {
  // SSE frames are blank-line separated. Scan them for the first
  // frame whose `event:` field matches.
  const frames = sse.split(/\n\n/);
  for (const frame of frames) {
    const lines = frame.split("\n");
    let id: string | undefined;
    let event: string | undefined;
    let data = "";
    for (const line of lines) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      }
    }
    if (event === eventName) return { id, data };
  }
  return null;
}

/**
 * Retires one event the way the retention sweep does, by removing its row.
 *
 * The sweep is the only thing that moves the log's oldest id, and it retires
 * only an event older than the retention, an hour at the shortest, so a stale
 * cursor is arranged here rather than provoked.
 */
async function retireEvent(id: bigint): Promise<void> {
  const db = ctx.storage.betterAuthDb as {
    delete: (table: unknown) => {
      where: (predicate: unknown) => Promise<unknown>;
    };
  };
  await db.delete(eventLog).where(eq(eventLog.id, Number(id)));
  const oldest = await ctx.storage.eventLog.getMinRetainedId();
  expect(oldest).not.toBeNull();
  expect(oldest! > id).toBe(true);
}

describe("GET /events — catchup_too_old", () => {
  it("refuses a cursor behind a log the sweep has retired to its newest event", async () => {
    // Every row older than the retention: the sweep keeps the newest, so the
    // log never empties and a cursor behind the retired stretch meets the
    // refusal rather than an empty log that cannot say anything is missing.
    const behind = await createNote("swept-1");
    await createNote("swept-2");
    const newest = await createNote("swept-3");
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    await run("UPDATE event_log SET created_at = ?", [
      new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ]);
    await ctx.storage.eventLog.cleanup(1);
    expect(await ctx.storage.eventLog.getMinRetainedId()).toBe(newest);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(behind) },
    });
    const { text } = await readSse(res, { untilClosed: true });
    const frame = findEvent(text, "catchup_too_old");
    expect(
      frame,
      "a cursor behind the swept log was replayed nothing, so the events it missed are lost untold",
    ).not.toBeNull();
    expect(frame!.id).toBe(String(newest));
    // The cases after this one arrange the log's oldest id themselves.
    await run("DELETE FROM event_log", []);
  });

  it("emits terminal catchup_too_old when the event after the cursor is no longer retained", async () => {
    const retired = await createNote("stale-cursor-1");
    const gone = await createNote("stale-cursor-2");
    const survivor = await createNote("stale-cursor-3");
    expect(gone > retired && survivor > gone).toBe(true);
    // The cursor names `retired` as the last event applied, so the client
    // needs everything after it, and the first of those is `gone`. Retiring
    // `retired` alone leaves that need answerable, which is the boundary the
    // in-step case below pins; retiring `gone` too is what makes the cursor
    // stale, because the event after it is no longer held.
    await retireEvent(retired);
    await retireEvent(gone);
    const oldest = (await ctx.storage.eventLog.getMinRetainedId())!;
    expect(oldest).toBe(survivor);
    // A cursor two or more behind the oldest retained id has lost an event.
    expect(oldest > retired + 1n).toBe(true);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(retired) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Waits for the close rather than for the frame. Terminal is a claim
    // about what the server does *after* emitting, and a read that stopped at
    // the frame never observed it.
    const { text, closed } = await readSse(res, { untilClosed: true });
    const frame = findEvent(text, "catchup_too_old");
    expect(frame).not.toBeNull();
    expect(frame!.id).toBe(String(oldest));
    const payload = JSON.parse(frame!.data) as {
      type: string;
      min_retained_id: string;
      requested: string;
    };
    expect(payload.type).toBe("catchup_too_old");
    expect(payload.min_retained_id).toBe(String(oldest));
    expect(payload.requested).toBe(String(retired));

    // Terminal means the server closes the stream after emitting, and a
    // stream that delivered nothing would satisfy "no item frames" on its
    // own, so the close is what is asserted.
    expect(closed).toBe(true);
    expect(text).not.toContain("item.");
    // A stream that ended short is never said to be live: the marker's
    // cursor is one a client may adopt, and this stream has none to
    // offer. `events-cursor.test.ts` is the witness that a stream which
    // finishes its prologue does send it.
    expect(text).not.toContain("event: stream_live");
  });

  it("replays from a cursor one below the oldest retained id, which is a client exactly in step", async () => {
    // A cursor of `0` against a log whose first event is `1` is a device
    // that hydrated an empty instance and has missed nothing, and a
    // comparison without the plus one refuses it. The log here is not empty
    // and not fresh, so the boundary is arranged the way the sweep arranges
    // it: retire everything before one event, then resume from the cursor
    // just below it.
    // One event written just to be retired, so the boundary is arranged by
    // this case rather than inherited from whatever ran before it.
    await createNote("boundary-before");
    const first = await createNote("boundary-first");
    const rows = await ctx.storage.eventLog.getAfter(0n, 10_000);
    let retired = 0;
    for (const row of rows) {
      if (row.id < first) {
        await retireEvent(row.id);
        retired += 1;
      }
    }
    expect(retired).toBeGreaterThan(0);
    const oldest = (await ctx.storage.eventLog.getMinRetainedId())!;
    expect(oldest).toBe(first);
    const cursor = oldest - 1n;

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(`id: ${String(first)}\n`),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
    expect(text).toContain(`id: ${String(first)}\n`);
  });

  it("replays normally when Last-Event-ID is within retention", async () => {
    const firstId = await createNote("within-retention-1");
    const secondId = await createNote("within-retention-2");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(firstId) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res, {
      until: (t) => t.includes(`id: ${String(secondId)}`),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
    // The second event should show up on replay.
    expect(text).toContain(`id: ${String(secondId)}`);
  });

  it("does not emit catchup_too_old when Last-Event-ID is absent", async () => {
    await createNote("no-cursor");
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    // `requireSeen` is what makes the absence mean something: the stream
    // opens with a `: connected` comment, so a window that saw it was
    // genuinely reading, and one that saw nothing fails loudly rather than
    // satisfying the assertion by delivering nothing.
    const { text } = await readSse(res, {
      requireSeen: (t) => t.startsWith(": connected\n\n"),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
  });

  it("emits an initial `: connected` SSE comment so proxies flush headers", async () => {
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    // Waits on the comment rather than betting that 100ms is long enough to
    // schedule the stream, which is the same wall-clock bet the replay tests
    // were losing under load.
    const { text } = await readSse(res, {
      until: (t) => t.startsWith(": connected\n\n"),
    });
    expect(text.startsWith(": connected\n\n")).toBe(true);
  });

  it("does not emit catchup_too_old when the event log is empty", async () => {
    // Spin up a second context with its own fresh storage so min(id) is
    // genuinely null. Sharing `ctx` would mean any prior test that
    // appended events makes min(id) non-null.
    const fresh = await createTestContext();
    initEventLog(fresh.storage.eventLog);
    try {
      const res = await request(fresh.app, "GET", "/events", {
        key: fresh.workingKey,
        headers: { "Last-Event-ID": "5" },
      });
      expect(res.status).toBe(200);
      const { text } = await readSse(res, {
        requireSeen: (t) => t.startsWith(": connected\n\n"),
      });
      expect(findEvent(text, "catchup_too_old")).toBeNull();
    } finally {
      await fresh.cleanup();
      // Restore the suite-wide event log binding so later tests keep
      // persisting through `ctx.storage.eventLog`.
      initEventLog(ctx.storage.eventLog);
    }
  });
});

describe("MARFA_EVENT_LOG_RETENTION_HOURS parser", () => {
  it("defaults to 168 when unset or empty", () => {
    expect(parseEventLogRetentionHours(undefined)).toBe(168);
    expect(parseEventLogRetentionHours("")).toBe(168);
  });

  it("accepts positive integers", () => {
    expect(parseEventLogRetentionHours("1")).toBe(1);
    expect(parseEventLogRetentionHours("24")).toBe(24);
    expect(parseEventLogRetentionHours("720")).toBe(720);
  });

  it("falls back to 168 for invalid values", () => {
    expect(parseEventLogRetentionHours("0")).toBe(168);
    expect(parseEventLogRetentionHours("-5")).toBe(168);
    expect(parseEventLogRetentionHours("1.5")).toBe(168);
    expect(parseEventLogRetentionHours("not-a-number")).toBe(168);
  });
});
