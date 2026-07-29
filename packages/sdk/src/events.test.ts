import { describe, expect, it, vi } from "vitest";

import { CatchupTooOldError, SseParser } from "./events.js";
import { HttpTransport } from "./transport.js";
import type { MarfaEvent, MarfaItemEvent } from "./events.js";

/** Build a transport whose fetch replays a scripted sequence of streams, one
 *  per connection attempt, so reconnect behaviour is observable. */
function transportOver(bodies: (string[] | { status: number })[]): {
  transport: HttpTransport;
  calls: Request[];
} {
  const calls: Request[] = [];
  let attempt = 0;
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    calls.push(new Request(input, init));
    const script = bodies[Math.min(attempt, bodies.length - 1)];
    attempt += 1;
    if (script && "status" in script) {
      return Promise.resolve(new Response(null, { status: script.status }));
    }
    const chunks = script ?? [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return {
    transport: new HttpTransport({
      baseUrl: "https://example.test",
      apiKey: "marfa_k1_test",
      fetch: fetchImpl,
    }),
    calls,
  };
}

/** A transport whose stream is driven by raw byte chunks, so a test can split
 *  the payload at a byte offset the string-level harness above cannot reach. */
function transportOverBytes(chunks: Uint8Array[]): HttpTransport {
  const fetchImpl: typeof globalThis.fetch = () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return new HttpTransport({
    baseUrl: "https://example.test",
    apiKey: "marfa_k1_test",
    fetch: fetchImpl,
  });
}

function itemFrame(id: string, itemId: string): string {
  return `id: ${id}\nevent: item.created\ndata: ${JSON.stringify({
    type: "item.created",
    item: { id: itemId },
  })}\n\n`;
}

describe("SseParser", () => {
  it("assembles a frame split across chunk boundaries", () => {
    const parser = new SseParser();
    // The split falls mid-field, which is where a per-chunk parser loses data.
    expect(parser.push("id: 1\nevent: item.cre")).toEqual([]);
    expect(parser.push('ated\ndata: {"type":"item.cre')).toEqual([]);
    const frames = parser.push('ated","item":{"id":"a"}}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("1");
    expect(frames[0]?.event).toBe("item.created");
  });

  it("yields several frames arriving in one chunk", () => {
    const parser = new SseParser();
    const frames = parser.push(itemFrame("1", "a") + itemFrame("2", "b"));
    expect(frames.map((f) => f.id)).toEqual(["1", "2"]);
  });

  it("ignores keep-alive pings without emitting a frame", () => {
    const parser = new SseParser();
    expect(parser.push(":ping\n\n")).toEqual([]);
    // A ping between two frames must not disturb either.
    const frames = parser.push(itemFrame("7", "a"));
    expect(frames.map((f) => f.id)).toEqual(["7"]);
  });

  it("strips exactly one leading space from a field value", () => {
    const parser = new SseParser();
    const frames = parser.push("id: 1\ndata:  two-spaces\n\n");
    // The first space is framing; the second belongs to the payload.
    expect(frames[0]?.data).toBe(" two-spaces");
  });

  it("handles CRLF line endings", () => {
    const parser = new SseParser();
    const frames = parser.push(
      "id: 9\r\nevent: item.created\r\ndata: {}\r\n\r\n",
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("item.created");
  });
});

describe("subscribe", () => {
  it("delivers events in order and tracks the cursor", async () => {
    const { transport } = transportOver([
      [itemFrame("1", "a"), itemFrame("2", "b")],
    ]);
    const seen: MarfaEvent[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      onEvent: (e) => {
        seen.push(e);
      },
      reconnect: false,
    });
    await sub.closed;
    expect(seen).toHaveLength(2);
    expect(sub.lastEventId).toBe("2");
  });

  it("sends Last-Event-ID on a resumed subscription", async () => {
    const { transport, calls } = transportOver([[itemFrame("5", "a")]]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      lastEventId: "4",
      onEvent: () => undefined,
      reconnect: false,
    });
    await sub.closed;
    expect(calls[0]?.headers.get("Last-Event-ID")).toBe("4");
  });

  it("resumes a reconnect from the last event seen, not the original cursor", async () => {
    // First connection delivers up to id 7 then ends; the reconnect must ask
    // for 7, not the 3 the caller started from. Getting this wrong replays
    // events 4 to 7 silently on every reconnect.
    const { transport, calls } = transportOver([
      [itemFrame("6", "a"), itemFrame("7", "b")],
      [itemFrame("8", "c")],
    ]);
    const seen: string[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      lastEventId: "3",
      initialRetryMs: 1,
      onEvent: (_e, id) => {
        seen.push(id ?? "");
        if (seen.length === 3) sub.close();
      },
    });
    await sub.closed;
    expect(calls[0]?.headers.get("Last-Event-ID")).toBe("3");
    expect(calls[1]?.headers.get("Last-Event-ID")).toBe("7");
  });

  it("treats catchup_too_old as terminal and hands back the retention window", async () => {
    const { transport, calls } = transportOver([
      [
        `id: 100\nevent: catchup_too_old\ndata: ${JSON.stringify({
          type: "catchup_too_old",
          min_retained_id: "100",
          requested: "3",
        })}\n\n`,
      ],
      [itemFrame("101", "a")],
    ]);
    const onCatchupTooOld = vi.fn();
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      lastEventId: "3",
      initialRetryMs: 1,
      onEvent: () => undefined,
      onCatchupTooOld,
    });
    await sub.closed;
    expect(onCatchupTooOld).toHaveBeenCalledWith({
      type: "catchup_too_old",
      min_retained_id: "100",
      requested: "3",
    });
    // Terminal means terminal: no reconnect, and the dead cursor is dropped so
    // it cannot be persisted and replayed later.
    expect(calls).toHaveLength(1);
    expect(sub.lastEventId).toBeUndefined();
  });

  it("throws rather than silently skipping the gap when catchup_too_old is unhandled", async () => {
    const { transport } = transportOver([
      [
        `id: 100\nevent: catchup_too_old\ndata: ${JSON.stringify({
          min_retained_id: "100",
          requested: "3",
        })}\n\n`,
      ],
    ]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      lastEventId: "3",
      onEvent: () => undefined,
    });
    await expect(sub.closed).rejects.toBeInstanceOf(CatchupTooOldError);
  });

  it("reconnects after a failed connection and reports the error", async () => {
    const { transport, calls } = transportOver([
      { status: 502 },
      [itemFrame("1", "a")],
    ]);
    const onError = vi.fn();
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 1,
      onError,
      onEvent: () => {
        sub.close();
      },
    });
    await sub.closed;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("decodes a multi-byte character split across a chunk boundary", async () => {
    // The string-level harness encodes each chunk whole, so it can never
    // produce this case, and a decoder without `{ stream: true }` passes every
    // other test in this file while silently corrupting real payloads. The
    // title here is a plausible one: non-ASCII in user content is ordinary,
    // not exotic.
    const title = "Café — naïve résumé";
    const frame =
      `id: 1\nevent: item.created\ndata: ` +
      JSON.stringify({ type: "item.created", item: { id: "a", title } }) +
      `\n\n`;
    const bytes = new TextEncoder().encode(frame);
    // Split inside the two-byte sequence for "é" in "Café".
    const eAcute = bytes.indexOf(0xc3);
    expect(eAcute).toBeGreaterThan(0);
    const transport = transportOverBytes([
      bytes.slice(0, eAcute + 1),
      bytes.slice(eAcute + 1),
    ]);

    const seen: MarfaEvent[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      onEvent: (e) => {
        seen.push(e);
      },
      reconnect: false,
    });
    await sub.closed;
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first && "item" in first).toBe(true);
    const item = (first as MarfaItemEvent).item as unknown as {
      title: string;
    };
    expect(item.title).toBe(title);
  });

  it("stops reading when the caller aborts", async () => {
    const controller = new AbortController();
    const { transport } = transportOver([[itemFrame("1", "a")]]);
    controller.abort();
    const onEvent = vi.fn();
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      signal: controller.signal,
      onEvent,
      reconnect: false,
    });
    await sub.closed;
    expect(onEvent).not.toHaveBeenCalled();
  });
});
