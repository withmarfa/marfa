/**
 * A reader that stops reading costs the server a bounded amount.
 *
 * The response's queue holds what the reader has not taken. A live frame
 * that finds the bound reached ends the stream with a frame saying the
 * reader fell behind, so everything after it stays in the log behind the
 * cursor the reader holds; a replay waits for the reader instead, because
 * it reads from the log at the reader's pace.
 *
 * Driven through `app.request`, whose body is the route's own stream, so
 * not reading it is exactly a reader that stopped and nothing between the
 * two buffers for it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import {
  createTestContext,
  readSse,
  request,
  settle,
  storedViewerKey,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  __listenerCountForTests,
  initEventLog,
  __resetEventLogForTests,
} from "../pubsub.js";
import { eventRoutes, type EventRoutesOptions } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

const BOUND = 16 * 1024;
/** Bodies large enough that a handful of frames pass the bound. */
const BODY = "x".repeat(2_000);

function appWith(options: EventRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", storedViewerKey(ctx.storage));
  app.route("/events", eventRoutes(ctx.storage, options));
  return app;
}

async function note(marker: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: `${marker}${BODY}` } },
  });
  expect(res.status).toBe(201);
}

/**
 * More rows than one page of a replay, in one bulk write, so a replay
 * from before them has to come back for a second page.
 */
async function backlog(label: string, count = 600): Promise<void> {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.workingKey,
    body: {
      items: Array.from({ length: count }, (_, i) => ({
        type: "core.note",
        properties: { body: `ZZ${label}${String(i)}ZZ` },
      })),
    },
  });
  expect(res.status).toBe(200);
}

function ids(text: string): bigint[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => BigInt(m[1]!));
}

describe("a live reader that stops reading", () => {
  it("is ended once its untaken frames reach the bound, told to resume from its cursor", async () => {
    const listenersBefore = __listenerCountForTests();
    const res = await appWith({ maxUnsentBytes: BOUND }).request("/events");
    expect(res.status).toBe(200);
    // Subscribed, and nothing read from here on.
    await settle();
    expect(__listenerCountForTests()).toBe(listenersBefore + 3);

    // Far past the bound: each frame is over 2 KB.
    const written = 40;
    for (let i = 0; i < written; i += 1) await note(`ZZstalled${String(i)}ZZ`);

    // The stream let go of its subscription without being read at all.
    expect(__listenerCountForTests()).toBe(listenersBefore);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    // The witness: frames were delivered before the bound was reached.
    const sent = ids(text);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(written);
    // What it held for the reader stayed near the bound: no more than the
    // bound plus the one frame that crossed it.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
      BOUND + 2 * (BODY.length + 1_000),
    );
    const terminal = text.slice(text.indexOf("event: stream_incomplete"));
    expect(terminal).toContain('"reason":"reader_behind"');
    expect(terminal).toContain(`"cursor":"${String(sent.at(-1))}"`);
    expect(terminal).not.toMatch(/^id:/m);

    // The resume: everything the stream did not send is in the log behind
    // that cursor, the last write included.
    const resumed = await appWith({}).request("/events", {
      headers: { "Last-Event-ID": String(sent.at(-1)) },
    });
    const { text: replayed } = await readSse(resumed, {
      until: (seen) => seen.includes("event: stream_live"),
    });
    expect(replayed).toContain(`ZZstalled${String(written - 1)}ZZ`);
    expect(ids(replayed)[0]).toBe(sent.at(-1)! + 1n);
  });

  it("is let go entirely when it never reads again", async () => {
    const res = await appWith({
      maxUnsentBytes: BOUND,
      readerStallMs: 100,
    }).request("/events");
    await settle();
    for (let i = 0; i < 20; i += 1) await note(`ZZabandoned${String(i)}ZZ`);
    await settle(300);
    // The queue was dropped and the body errored, rather than held for a
    // reader that is not coming back.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow("the reader stopped reading");
  });
});

describe("a replay to a slow reader", () => {
  it("waits for the reader rather than ending, however far behind it starts", async () => {
    const from = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    await backlog("slow");

    const res = await appWith({ maxUnsentBytes: BOUND }).request("/events", {
      headers: { "Last-Event-ID": String(from) },
    });
    // Not read for a while: the first page alone is many times the
    // bound, and a live stream would have been ended by now.
    await settle(200);
    const { text } = await readSse(res, {
      until: (seen) => seen.includes("event: stream_live"),
    });
    expect(text).not.toContain("stream_incomplete");
    expect(text).toContain("ZZslow0ZZ");
    expect(text).toContain("ZZslow599ZZ");
  });

  it("holds no more than the bound and one frame for a stalled reader, however large the page", async () => {
    const from = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    // One page of the log, many times the bound.
    for (let i = 0; i < 4; i += 1) {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: 15 }, (_, j) => ({
            type: "core.note",
            properties: { body: `ZZbig${String(i)}-${String(j)}ZZ${BODY}` },
          })),
        },
      });
      expect(res.status).toBe(200);
    }
    const res = await appWith({
      maxUnsentBytes: BOUND,
      readerStallMs: 300,
    }).request("/events", {
      headers: { "Last-Event-ID": String(from) },
    });
    // Nothing read until the replay has given up on the reader.
    await settle(450);
    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain('"reason":"reader_behind"');
    // The witness: the replay sent rows before it stopped.
    expect(text).toContain("ZZbig0-0ZZ");
    const frame = BODY.length + 1_000;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
      BOUND + 2 * frame,
    );
  });

  it("keeps a reader that takes frames slowly but steadily", async () => {
    const from = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    await backlog("steady");
    const res = await appWith({
      maxUnsentBytes: BOUND,
      readerStallMs: 300,
    }).request("/events", {
      headers: { "Last-Event-ID": String(from) },
    });
    // A reader taking one chunk at a time with a pause between, never
    // pausing as long as the stall budget, but far slower than the replay.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: stream_live")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      await settle(5);
    }
    await reader.cancel();
    expect(text).not.toContain("stream_incomplete");
    expect(text).toContain("ZZsteady599ZZ");
  });

  it("judges each row by the credential as it stands once there is room for it", async () => {
    const from = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: Array.from({ length: 30 }, (_, i) => ({
          type: "core.task",
          properties: { title: `ZZpaced${String(i)}ZZ${BODY}` },
        })),
      },
    });
    expect(res.status).toBe(200);
    const viewer = await ctx.storage.keys.create(
      {
        label: "paced-narrowed",
        source: `paced-narrowed-${String(Date.now())}`,
        type_permissions: { "core.task": "read", "core.note": "read" },
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        permissions: [],
        is_operator: false,
      },
      "paced-narrowed-hash",
    );
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiKey", viewer);
      await next();
    });
    app.route(
      "/events",
      eventRoutes(ctx.storage, {
        maxUnsentBytes: BOUND,
        readerStallMs: 5_000,
        keepAliveMs: 100,
      }),
    );
    const stream = await app.request("/events", {
      headers: { "Last-Event-ID": String(from) },
    });
    // The replay fills the queue and waits for the reader, who has not
    // read; the key loses tasks, and a heartbeat reads it again.
    await settle(300);
    await ctx.storage.keys.update(viewer.id, {
      type_permissions: { "core.note": "read" },
    });
    await settle(400);
    const { text } = await readSse(stream, {
      until: (seen) => seen.includes("event: stream_live"),
    });
    // Everything at or past the bound was queued after the reader began
    // reading, so after the key changed. The witness: tasks were sent
    // before it.
    const before = text.slice(0, BOUND);
    expect(before).toContain("ZZpaced0ZZ");
    const after = text.slice(text.indexOf("\n\n", BOUND));
    expect(
      after,
      "a task frame was sent after the key lost tasks",
    ).not.toContain('"type":"core.task"');
  });

  it("ends when the reader takes nothing for the stall budget", async () => {
    const from = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    await backlog("stalled");
    const res = await appWith({
      maxUnsentBytes: BOUND,
      readerStallMs: 400,
    }).request("/events", {
      headers: { "Last-Event-ID": String(from) },
    });
    // Past the stall budget, inside the grace that follows it.
    await settle(550);
    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    // The witness: the replay had sent its first page.
    expect(text).toContain("ZZstalled0ZZ");
    expect(text).not.toContain("ZZstalled599ZZ");
    expect(text).toContain('"reason":"reader_behind"');
    expect(text).not.toContain("event: stream_live");
  });
});
