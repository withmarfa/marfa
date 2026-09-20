import { afterEach, describe, expect, it, vi } from "vitest";

import { CatchupTooOldError, SseParser } from "./events.js";
import { HttpTransport } from "./transport.js";
import type { MarfaEvent, MarfaItemEvent } from "./events.js";

/** Build a transport whose fetch replays a scripted sequence of streams, one
 *  per connection attempt, so reconnect behavior is observable. */
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

/**
 * The announced cursor: what a client that has none can resume from, and
 * what a client that has one must not be talked out of.
 */
describe("the announced cursor", () => {
  function cursorFrame(cursor: string): string {
    return `event: stream_cursor\ndata: ${JSON.stringify({
      type: "stream_cursor",
      cursor,
    })}\n\n`;
  }

  it("surfaces it, keeps it out of onEvent, and adopts it when there is none", async () => {
    const { transport, calls } = transportOver([
      [cursorFrame("42")],
      [itemFrame("43", "a")],
    ]);
    const announced: string[] = [];
    const seen: MarfaEvent[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 1,
      onCursor: (cursor) => {
        announced.push(cursor);
      },
      onEvent: (event) => {
        seen.push(event);
        sub.close();
      },
    });
    await sub.closed;

    expect(announced).toEqual(["42"]);
    expect(
      seen.map((e) => e.type),
      "the announcement is not a change, so it must not reach onEvent",
    ).toEqual(["item.created"]);
    expect(
      calls[1]?.headers.get("Last-Event-ID"),
      "a subscription that started with no cursor resumes from the one it was handed",
    ).toBe("42");
  });

  it("leaves a resume cursor where it was, so a reconnect keeps its backlog", async () => {
    // The announcement names the head of the log, which on a resuming
    // connection sits past the backlog that connection is about to
    // replay. Adopting it there and then dropping mid-replay would leave
    // the cursor over events the caller never saw and never asks for
    // again — the exact loss this frame exists to prevent.
    const { transport, calls } = transportOver([
      [cursorFrame("99")],
      [itemFrame("100", "a")],
    ]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      lastEventId: "3",
      initialRetryMs: 1,
      onEvent: () => {
        sub.close();
      },
    });
    await sub.closed;

    expect(calls[0]?.headers.get("Last-Event-ID")).toBe("3");
    expect(
      calls[1]?.headers.get("Last-Event-ID"),
      "an announcement must not move a cursor that already had a backlog behind it",
    ).toBe("3");
  });

  it("sends the type and edge filters it was given", async () => {
    // The server refuses an edges value it cannot honor, which is only
    // worth anything if the value reaches it: a client option dropped in
    // the transport is the silent filter this whole parameter removes.
    const { transport, calls } = transportOver([[itemFrame("1", "a")]]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      type: "core.note,core.media",
      edges: "none",
      onEvent: () => undefined,
      reconnect: false,
    });
    await sub.closed;

    const url = new URL(calls[0]?.url ?? "https://example.test");
    expect(url.searchParams.get("type")).toBe("core.note,core.media");
    expect(url.searchParams.get("edges")).toBe("none");
  });
});

/**
 * The frame that says the server stopped delivering.
 *
 * It arrives on a healthy connection, carries no `id:`, and is followed
 * by a close — and the cursor the subscription holds is still the right
 * one, because nothing after the gap was sent. So the correct behavior is
 * the ordinary reconnect from that cursor, which is the opposite of
 * `catchup_too_old`.
 *
 * The reason it needs an arm of its own rather than falling through: the
 * router parses any frame it does not recognize and hands it to
 * `onEvent`, where it would arrive as a `MarfaEvent` it is not a member
 * of. A caller switching on `type` ignores it, and one keying off `item`
 * drops it for want of one, but neither is a contract — and a control frame
 * reaching an event handler is a lie about the type either way.
 */
describe("a stream that stopped delivering", () => {
  function incompleteFrame(reason: string, cursor: string | null): string {
    return `event: stream_incomplete\ndata: ${JSON.stringify({
      type: "stream_incomplete",
      reason,
      cursor,
    })}\n\n`;
  }

  it("surfaces it, keeps it out of onEvent, and reconnects from the cursor it held", async () => {
    const { transport, calls } = transportOver([
      [itemFrame("7", "a"), incompleteFrame("replay_failed", "7")],
      [itemFrame("8", "b")],
    ]);
    const reported: { reason: string; cursor: string | null }[] = [];
    const seen: MarfaEvent[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 1,
      onStreamIncomplete: (info) => {
        reported.push({ reason: info.reason, cursor: info.cursor });
      },
      onEvent: (event) => {
        seen.push(event);
        if (seen.length === 2) sub.close();
      },
    });
    await sub.closed;

    expect(reported).toEqual([{ reason: "replay_failed", cursor: "7" }]);
    expect(
      seen.map((e) => e.type),
      "a control frame is not a change, so it must not reach onEvent",
    ).toEqual(["item.created", "item.created"]);
    expect(
      calls[1]?.headers.get("Last-Event-ID"),
      "the cursor is still good, so the reconnect resumes at the gap",
    ).toBe("7");
  });

  it("does not throw when no handler was supplied", async () => {
    // Unlike `catchup_too_old`, nothing is required of the caller: the
    // subscription recovers on its own, so an absent handler costs the
    // reason and nothing else. Escalating would turn a self-healing
    // reconnect into an error the caller has to suppress.
    const { transport } = transportOver([
      [incompleteFrame("edge_delivery_failed", null)],
      [itemFrame("1", "a")],
    ]);
    const errors: unknown[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 1,
      onError: (err) => {
        errors.push(err);
      },
      onEvent: () => {
        sub.close();
      },
    });
    await sub.closed;

    expect(errors).toEqual([]);
  });
});

describe("the cursor advances on acknowledgment", () => {
  it("replays the event whose handler rejected", async () => {
    // The property the whole policy is for. The handler fails on id 7, so the
    // reconnect must ask for 6 — the last event actually accounted for — and
    // 7 arrives again. Advancing on receipt loses it silently, which is the
    // shape of a sync that reports success and is missing a row.
    const { transport, calls } = transportOver([
      [itemFrame("6", "a"), itemFrame("7", "b")],
      [itemFrame("7", "b"), itemFrame("8", "c")],
    ]);

    const delivered: string[] = [];
    let failOnce = true;
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 1,
      onError: () => undefined,
      onEvent: (_e, id) => {
        if (id === "7" && failOnce) {
          failOnce = false;
          return Promise.reject(new Error("handler refused"));
        }
        delivered.push(id ?? "");
        if (id === "8") sub.close();
        return Promise.resolve();
      },
    });
    await sub.closed;

    expect(calls[0]?.headers.get("Last-Event-ID")).toBeNull();
    expect(calls[1]?.headers.get("Last-Event-ID")).toBe("6");
    expect(delivered).toEqual(["6", "7", "8"]);
  });

  it("does not advance past an event still in flight", async () => {
    // The cursor read mid-handler must not yet include the event being
    // handled, or a caller persisting it from inside the handler records
    // progress it has not made.
    const { transport } = transportOver([[itemFrame("1", "a")]]);
    const seenDuringHandler: (string | undefined)[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      reconnect: false,
      onEvent: () => {
        seenDuringHandler.push(sub.lastEventId);
      },
    });
    await sub.closed;

    expect(seenDuringHandler).toEqual([undefined]);
    expect(sub.lastEventId).toBe("1");
  });

  it("advances past a frame carrying an id and no payload", async () => {
    // A guard rather than a regression: this passed before the change too.
    // It is the case the acknowledgment rule could plausibly break, since
    // nothing is delivered and there is no handler to wait for, and a cursor
    // that stalls on keep-alive framing replays from the same point forever.
    const { transport } = transportOver([["id: 42\ndata: \n\n"]]);
    const onEvent = vi.fn();
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      reconnect: false,
      onEvent,
    });
    await sub.closed;

    expect(onEvent).not.toHaveBeenCalled();
    expect(sub.lastEventId).toBe("42");
  });

  it("skips an unreadable payload on the same connection rather than replaying it", async () => {
    // A payload that will not parse now will not parse on a replay, so
    // leaving the cursor behind it means reconnecting into the same failure
    // for ever. It is reported and stepped over, and the connection carries
    // on: the following event still arrives, on the same connection.
    const { transport, calls } = transportOver([
      ["id: 1\ndata: {not json\n\n", itemFrame("2", "b")],
    ]);
    const onError = vi.fn();
    const delivered: string[] = [];
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      reconnect: false,
      onError,
      onEvent: (_e, id) => {
        delivered.push(id ?? "");
      },
    });
    await sub.closed;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["2"]);
    expect(sub.lastEventId).toBe("2");
    expect(calls).toHaveLength(1);
  });
});

describe("the backoff resets on progress, not on connect", () => {
  // Deterministic: `jitter` is `ms / 2 + random * (ms / 2)`, so pinning
  // random to zero makes every delay exactly half the current backoff.
  // Without that the assertions below are a bet on scheduling.
  const halfDelays = (): void => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("backs off a connection that opens, delivers nothing and dies", async () => {
    // Under at-least-once this is the difference between a poison event
    // costing an exponentially-backed-off retry and it costing a 500ms hot
    // loop forever. A connection that opened is not evidence of health; one
    // that moved the cursor is.
    halfDelays();
    vi.useFakeTimers();
    const { transport, calls } = transportOver([[]]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 40,
      onEvent: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(2); // backoff was 40, so the delay was 20

    // Pre-fix the backoff reset to 40 on every open, so another 20ms bought
    // a third attempt. It is now 80, so the delay is 40 and this buys none.
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(3);

    sub.close();
    await sub.closed;
  });

  it("returns to the first delay once a connection delivers something", async () => {
    halfDelays();
    vi.useFakeTimers();
    // Two empty connections take the backoff to 160, then one that delivers
    // an event puts it back to 40.
    const { transport, calls } = transportOver([
      [],
      [],
      [itemFrame("1", "a")],
      [],
    ]);
    const sub = (await import("./events.js")).subscribeToEvents(transport, {
      initialRetryMs: 40,
      onEvent: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(20); // backoff 40
    await vi.advanceTimersByTimeAsync(40); // backoff 80
    expect(calls).toHaveLength(3);

    // The third connection delivered an event, so the next delay is 20
    // again rather than the 80 the doubling would have reached.
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(4);

    sub.close();
    await sub.closed;
  });
});
