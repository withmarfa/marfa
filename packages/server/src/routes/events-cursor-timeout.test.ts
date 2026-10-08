/**
 * The hold the announcement takes is bounded.
 *
 * Every connection withholds live delivery from its first moment, so that
 * the cursor can be the stream's first frame, and the frames it withholds
 * accumulate in memory with no ceiling of their own. The read that ends
 * the hold goes to the database like any other, so a database slow enough
 * is enough to leave it outstanding, and a viewer that never drains is
 * still counted against the viewer cap and still holds its two emitter
 * listeners.
 *
 * The degradation is deliberately the weaker of the two available ones.
 * A client that receives no `stream_cursor` frame is connected and live,
 * holding no cursor of its own, with a reconnect path that already covers
 * it; the marker that ends its prologue names no position either, since
 * the stream knows none. A client whose frames are held forever is in no
 * documented state at all. So the budget expiring announces no cursor and
 * releases the hold rather than closing the stream, which is what a
 * genuine read *failure* does.
 *
 * With `rlsEnforce: false` the head read is a plain call into the
 * event-log store, which is what this stalls.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { MarfaError } from "@withmarfa/shared";
import { createTestContext, storedViewerKey } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { emitWake, type ItemEventWithId } from "../pubsub.js";
import { eventRoutes, type EventRoutesOptions } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";
import type { EventLogStore, Storage } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * The same storage with a head read that never comes back.
 *
 * Delegation through the prototype rather than a hand-built stub, so the
 * object is the real store in every respect but the one method under
 * test — a stub would also pass if the route had started asking a
 * different question.
 */
function withStalledHeadRead(storage: Storage): Storage {
  const eventLog = Object.create(storage.eventLog) as EventLogStore;
  Object.defineProperty(eventLog, "getMaxId", {
    value: () => new Promise<bigint | null>(() => undefined),
  });
  const stalled = Object.create(storage) as Storage;
  Object.defineProperty(stalled, "eventLog", { value: eventLog });
  return stalled;
}

function makeApp(storage: Storage, options: EventRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", storedViewerKey(ctx));
  app.route("/events", eventRoutes(storage, options));
  app.onError((err, c) => {
    if (err instanceof MarfaError) {
      return c.json({ error: { code: err.code } }, err.status as 503);
    }
    throw err;
  });
  return app;
}

interface OpenStream {
  res: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: string;
}

/** Open a stream and read up to its first chunk, leaving it open. */
async function openStream(app: Hono<AppEnv>): Promise<OpenStream> {
  const res = await app.request("/events");
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("SSE response carried no body");
  const reader = res.body.getReader();
  const first = await reader.read();
  const firstChunk = first.value ? new TextDecoder().decode(first.value) : "";
  return { res, reader, firstChunk };
}

/** Long past the head read's budget, so what it catches is a frame
 *  that is never written rather than one still on its way. */
const READ_DEADLINE_MS = 5_000;

/**
 * Read until `marker` appears, or fail naming it. A stream that never
 * writes the frame would otherwise run out the runner's budget, and that
 * failure says nothing about which frame was missing.
 */
async function readUntil(open: OpenStream, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = open.firstChunk;
  const deadline = setTimeout(() => {
    void open.reader.cancel();
  }, READ_DEADLINE_MS);
  try {
    while (!text.includes(marker)) {
      const chunk = await open.reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
  } finally {
    clearTimeout(deadline);
  }
  if (!text.includes(marker)) {
    throw new Error(
      `the stream never wrote "${marker}" within ${String(READ_DEADLINE_MS)}ms; received: ${JSON.stringify(text)}`,
    );
  }
  return text;
}

function wake(itemId: string): void {
  emitWake({
    type: "created",
    item: {
      id: itemId,
      type: "core.note",
      properties: {},
    } as unknown as ItemEventWithId["item"],
  });
}

describe("GET /events — the cursor announcement is bounded", () => {
  it("announces nothing and releases the hold when the head read outruns its budget", async () => {
    const app = makeApp(withStalledHeadRead(ctx.storage), {
      headReadTimeoutMs: 150,
    });
    const open = await openStream(app);
    expect(open.firstChunk).toContain(": connected");

    // Published while the stream is still holding, so it exercises the
    // half that matters: a held frame is drained when the budget
    // expires rather than stranded behind a read that never returns.
    wake("evt-cursor-timeout-held");

    const text = await readUntil(open, "event: stream_live");
    try {
      expect(
        text,
        "a frame held behind a stalled head read must still be delivered",
      ).toContain("evt-cursor-timeout-held");
      expect(
        text,
        "a head read that never returned has no cursor to announce",
      ).not.toContain("event: stream_cursor");
      // The prologue still ends, and says so; with no head and nothing
      // replayed, the position it names is none.
      expect(text).toContain("event: stream_live");
      expect(text).toContain('"cursor":null');
      expect(text.indexOf("event: stream_live")).toBeGreaterThan(
        text.indexOf("evt-cursor-timeout-held"),
      );
    } finally {
      await open.reader.cancel();
    }
  });

  it("still announces when the head read answers, so the absence above is the stall", async () => {
    // Without this the first case passes on a harness that never
    // announces for reasons of its own, which is the same result and a
    // different fact.
    const app = makeApp(ctx.storage, {
      headReadTimeoutMs: 150,
    });
    const open = await openStream(app);
    const text = await readUntil(open, "event: stream_cursor");
    try {
      expect(text).toContain("event: stream_cursor");
    } finally {
      await open.reader.cancel();
    }
  });
});
