/**
 * An open event stream is ended with its closing frame when the instance
 * stops, rather than cut: `stream_incomplete` with the reason
 * `server_stopping`, the cursor of the last event it sent, no `id:`, and
 * then the end of the body.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, readSse, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import {
  endOpenStreams,
  resetOpenStreamsForTesting,
  trackStream,
} from "./open-streams.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this nothing is appended, and a frame carries no id for a
  // cursor to name: the test context installs no event log.
  initEventLog(ctx.storage.eventLog);
});

afterEach(() => {
  resetOpenStreamsForTesting();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function open(path = "/events"): Promise<Response> {
  const res = await request(ctx.app, "GET", path, { key: ctx.workingKey });
  expect(res.status).toBe(200);
  return res;
}

/** The terminal frame in a read, as its data. */
function closingFrame(text: string): Record<string, unknown> {
  const frames = text
    .split("\n\n")
    .filter((frame) => frame.includes("event: stream_incomplete"));
  expect(frames).toHaveLength(1);
  const frame = frames[0] ?? "";
  expect(frame).not.toMatch(/^id: /m);
  const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "{}";
  return JSON.parse(data) as Record<string, unknown>;
}

describe("a stream when the instance stops", () => {
  // The witness for everything below: left alone, a stream opened here
  // stays open, which is why the server's close never resolves on one.
  it("stays open until it is told", async () => {
    const res = await open();

    const read = await readSse(res, {
      until: (text) => text.includes("stream_live"),
    });

    expect(read.text).toContain("stream_live");
    expect(read.closed).toBe(false);
  });

  it("is ended with server_stopping and then closed, having delivered what it had", async () => {
    const res = await open();
    let told = false;

    const read = await readSse(res, {
      untilClosed: true,
      onChunk: (text) => {
        if (!told && text.includes("stream_live")) {
          told = true;
          expect(endOpenStreams()).toBe(1);
        }
      },
    });

    expect(read.closed).toBe(true);
    expect(closingFrame(read.text)).toMatchObject({
      event_type: "stream_incomplete",
      reason: "server_stopping",
      cursor: null,
    });
  });

  it("names the last event it sent, so the reader reconnects from it", async () => {
    const res = await open();
    let wrote = false;
    let told = false;
    let sent = "";

    const read = await readSse(res, {
      untilClosed: true,
      onChunk: (text) => {
        if (!wrote && text.includes("stream_live")) {
          wrote = true;
          void request(ctx.app, "POST", "/items", {
            key: ctx.workingKey,
            body: {
              type: "core.note",
              properties: { body: "before the stop" },
            },
          });
        }
        const delivered = /^id: (\d+)$/m.exec(text)?.[1];
        if (!told && delivered !== undefined) {
          told = true;
          sent = delivered;
          endOpenStreams();
        }
      },
    });

    expect(sent).not.toBe("");
    expect(closingFrame(read.text)).toMatchObject({
      reason: "server_stopping",
      cursor: sent,
    });
  });

  it("ends a copy stream the same way", async () => {
    const res = await open("/events?edges=all&copy=1");
    let told = false;

    const read = await readSse(res, {
      untilClosed: true,
      onChunk: (text) => {
        if (!told && text.includes("stream_live")) {
          told = true;
          endOpenStreams();
        }
      },
    });

    expect(read.closed).toBe(true);
    expect(closingFrame(read.text)).toMatchObject({
      reason: "server_stopping",
    });
  });

  it("ends every stream that is open, and each only once", async () => {
    const first = await open();
    const second = await open();
    let told = 0;
    const tell = (text: string) => {
      if (text.includes("stream_live")) {
        told += 1;
        if (told === 2) expect(endOpenStreams()).toBe(2);
      }
    };

    const [a, b] = await Promise.all([
      readSse(first, { untilClosed: true, onChunk: tellOnce(tell) }),
      readSse(second, { untilClosed: true, onChunk: tellOnce(tell) }),
    ]);

    expect(closingFrame(a.text)).toMatchObject({ reason: "server_stopping" });
    expect(closingFrame(b.text)).toMatchObject({ reason: "server_stopping" });
    expect(endOpenStreams()).toBe(0);
  });

  it("ends a stream that opens after the stop began, at once", async () => {
    endOpenStreams();

    const res = await open();
    const read = await readSse(res, { untilClosed: true });

    expect(closingFrame(read.text)).toMatchObject({
      reason: "server_stopping",
    });
  });

  it("does not let one stream that will not end keep the others from being told", () => {
    const told: string[] = [];
    trackStream(() => {
      throw new Error("a connection that is already gone");
    });
    trackStream(() => {
      told.push("second");
    });

    expect(endOpenStreams()).toBe(2);
    expect(told).toEqual(["second"]);
  });
});

/** Runs a callback on a stream's first sight of the opening frame only. */
function tellOnce(tell: (text: string) => void): (text: string) => void {
  let seen = false;
  return (text) => {
    if (seen || !text.includes("stream_live")) return;
    seen = true;
    tell(text);
  };
}
