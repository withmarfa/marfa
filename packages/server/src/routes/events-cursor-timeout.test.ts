/**
 * The hold the announcement takes is bounded.
 *
 * Every connection now withholds live delivery from its first moment, so
 * that the cursor can be the stream's first frame, and the frames it
 * withholds accumulate in memory with no ceiling of their own. The read
 * that ends the hold takes the ordinary app pool, so a saturated pool is
 * enough to leave it outstanding — and a viewer that never drains is
 * still counted against the viewer cap and still holds its two emitter
 * listeners. On `main` the only hold was the replay's, and the
 * reservation in front of it was already bounded, so nothing else in this
 * route has this shape.
 *
 * The degradation is deliberately the weaker of the two available ones.
 * A client that receives no `stream_cursor` frame is exactly where every
 * client stood before the frame existed: connected, live, holding no
 * cursor of its own, with a reconnect path that already covers it. A
 * client whose frames are held forever is in no documented state at all.
 * So the budget expiring announces nothing and releases the hold rather
 * than closing the stream, which is what a genuine read *failure* does.
 *
 * Dialect-independent: with `rlsEnforce: false` the head read is a plain
 * call into the event-log store, which is what this stalls.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
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

function spaceKey(): ApiKey {
  return {
    id: "key_events_cursor_timeout",
    name: "events cursor timeout",
    key_hash: "unused",
    // The rank this fixture used to carry admitted it past its own maps, so
    // the map has to say what the rank granted silently.
    type_permissions: { "*": "read" },
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
  } as unknown as ApiKey;
}

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
  app.use("*", async (c, next) => {
    c.set("apiKey", spaceKey());
    await next();
  });
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

/**
 * Read until `marker` appears. No deadline of its own — the runner's
 * budget is what ends a run that never gets one, and a deadline written
 * here would re-emit a timeout as a logic failure that names nothing.
 */
async function readUntil(open: OpenStream, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = open.firstChunk;
  while (!text.includes(marker)) {
    const chunk = await open.reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
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

    const text = await readUntil(open, "evt-cursor-timeout-held");
    try {
      expect(
        text,
        "a frame held behind a stalled head read must still be delivered",
      ).toContain("evt-cursor-timeout-held");
      expect(
        text,
        "a head read that never returned has no cursor to announce",
      ).not.toContain("event: stream_cursor");
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
