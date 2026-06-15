import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import { parseEventLogRetentionHours } from "../config.js";

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
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  (await res.json()) as CreatedItem;
  const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
  expect(after.length).toBeGreaterThan(0);
  return maxBigInt(after.map((e) => e.id));
}

/**
 * Read an SSE response body in chunks until either `want` event lines
 * are observed, the stream closes, or a short timeout elapses. Returns
 * the raw text accumulated plus a `closed` flag. Tests use this rather
 * than reading to end-of-stream because the SSE endpoint is intended
 * to stay open — we bound the wait explicitly.
 */
async function readSse(
  res: Response,
  opts: { timeoutMs?: number } = {},
): Promise<{ text: string; closed: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 500;
  expect(res.body).not.toBeNull();
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const tick = new Promise<{ value?: Uint8Array; done: boolean }>(
      (resolve) => {
        const t = setTimeout(
          () => {
            resolve({ done: false });
          },
          Math.min(remaining, 50),
        );
        reader
          .read()
          .then((r) => {
            clearTimeout(t);
            resolve(r);
          })
          .catch(() => {
            clearTimeout(t);
            resolve({ done: true });
          });
      },
    );
    const r = await tick;
    if (r.done) {
      closed = true;
      break;
    }
    if (r.value) {
      text += decoder.decode(r.value, { stream: true });
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return { text, closed };
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

describe("GET /events — catchup_too_old", () => {
  it("emits terminal catchup_too_old when Last-Event-ID predates retention", async () => {
    const eventId = await createNote("stale-cursor-1");
    expect(eventId > 0n).toBe(true);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.adminKey,
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const { text, closed } = await readSse(res);
    const frame = findEvent(text, "catchup_too_old");
    expect(frame).not.toBeNull();
    expect(frame!.id).toBe(String(eventId));
    // Payload now serializes bigint ids as strings (JSON-safe round-trip).
    const payload = JSON.parse(frame!.data) as {
      type: string;
      min_retained_id: string;
      requested: string;
    };
    expect(payload.type).toBe("catchup_too_old");
    expect(BigInt(payload.min_retained_id) >= 1n).toBe(true);
    expect(payload.requested).toBe("0");

    // Terminal: the stream should have closed after emitting. Either the
    // server already closed (closed=true) or at least no live events
    // followed the control frame in the observation window.
    expect(closed || !text.includes("item.")).toBe(true);
  });

  it("replays normally when Last-Event-ID is within retention", async () => {
    const firstId = await createNote("within-retention-1");
    const secondId = await createNote("within-retention-2");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.adminKey,
      headers: { "Last-Event-ID": String(firstId) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res);
    expect(findEvent(text, "catchup_too_old")).toBeNull();
    // The second event should show up on replay.
    expect(text).toContain(`id: ${String(secondId)}`);
  });

  it("does not emit catchup_too_old when Last-Event-ID is absent", async () => {
    await createNote("no-cursor");
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, { timeoutMs: 200 });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
  });

  it("emits an initial `: connected` SSE comment so proxies flush headers", async () => {
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, { timeoutMs: 100 });
    expect(text.startsWith(": connected\n\n")).toBe(true);
  });

  it("does not emit catchup_too_old when the event log is empty for the tenant", async () => {
    // Spin up a second context with its own fresh storage so min(id) is
    // genuinely null. Sharing `ctx` would mean any prior test that
    // appended events makes min(id) non-null.
    const fresh = await createTestContext();
    initEventLog(fresh.storage.eventLog);
    try {
      const res = await request(fresh.app, "GET", "/events", {
        key: fresh.adminKey,
        headers: { "Last-Event-ID": "5" },
      });
      expect(res.status).toBe(200);
      const { text } = await readSse(res, { timeoutMs: 200 });
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
