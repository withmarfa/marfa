import { describe, expect, it } from "vitest";
import type { EventStream } from "./sse.js";
import { awaitStreamCursor, collectUntil } from "./stream.js";

const frame = (id: string, event: string, data: unknown) =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A stream that delivers each chunk as its own read, then stays open. */
function streamOf(chunks: Uint8Array[]): EventStream {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
    },
  });
  return { response: new Response(body), close: async () => undefined };
}

const encode = (text: string) => new TextEncoder().encode(text);
const ids = (events: { id?: string }[]) => events.map((e) => e.id);
const hasId = (id: string) => (events: { id?: string }[]) =>
  events.some((e) => e.id === id);

describe("stream reads", () => {
  it("keeps the start of a frame the read stopped inside, for the next read", async () => {
    const six = frame("6", "item.created", { n: 6 });
    const seven = frame("7", "item.created", { n: 7 });
    const cut = Math.floor(seven.length / 2);
    const stream = streamOf([
      encode(six + seven.slice(0, cut)),
      encode(seven.slice(cut)),
    ]);

    const first = await collectUntil(stream, hasId("6"), "event 6");
    expect(ids(first.events)).toEqual(["6"]);

    const second = await collectUntil(stream, hasId("7"), "event 7");
    expect(ids(second.events)).toEqual(["7"]);
  });

  it("carries what follows the cursor frame, a partial frame included", async () => {
    const cursor = frame("", "stream_cursor", { cursor: "5" });
    const six = frame("6", "item.created", { n: 6 });
    const seven = frame("7", "item.created", { n: 7 });
    const cut = Math.floor(seven.length / 2);
    const stream = streamOf([
      encode(cursor + six + seven.slice(0, cut)),
      encode(seven.slice(cut)),
    ]);

    expect(await awaitStreamCursor(stream)).toBe("5");

    const first = await collectUntil(stream, hasId("6"), "event 6");
    expect(ids(first.events)).toEqual(["6"]);

    const second = await collectUntil(stream, hasId("7"), "event 7");
    expect(ids(second.events)).toEqual(["7"]);
  });

  it("keeps the first bytes of a character that a read ended inside", async () => {
    const six = frame("6", "item.created", { n: 6 });
    const seven = frame("7", "item.created", { text: "caf\u00e9" });
    const bytes = encode(six + seven);
    // The two bytes of the e with an acute accent, split between reads.
    const split = bytes.indexOf(0xc3) + 1;
    const stream = streamOf([bytes.slice(0, split), bytes.slice(split)]);

    await collectUntil(stream, hasId("6"), "event 6");

    const second = await collectUntil(stream, hasId("7"), "event 7");
    expect(second.events.map((e) => e.data)).toEqual([{ text: "caf\u00e9" }]);
  });
});
