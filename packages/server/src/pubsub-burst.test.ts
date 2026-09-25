/**
 * One subscription hands a burst of item and edge events on in the order
 * they were published, however long the consumer takes to come back.
 *
 * The stream's consumer awaits an edge frame's send before it takes the
 * next frame, so everything published in the meantime queues inside the
 * subscription. A queue drained from the wrong end, or one that put edge
 * events ahead of item events, would pass every test that lets the
 * consumer keep up, because a queue holding one frame has no order to get
 * wrong. So the consumer here does not keep up: every event is published
 * before the first is taken.
 */
import { describe, expect, it } from "vitest";
import type { Edge, Item } from "@withmarfa/shared";
import { __listenerCountForTests, emitWake, subscribeAll } from "./pubsub.js";
import type { LiveFrame, PubsubEventWithId } from "./pubsub.js";

function itemEvent(id: number, type = "core.note"): PubsubEventWithId {
  return {
    type: "updated",
    item: { id: `item-${String(id)}`, type } as Item,
    eventId: BigInt(id),
  };
}

function edgeEvent(id: number): PubsubEventWithId {
  return {
    type: "edge_created",
    edge: { id: `edge-${String(id)}` } as Edge,
    eventId: BigInt(id),
  };
}

/** The frame's id, as the subscription hands it on. */
function idOf(frame: LiveFrame): bigint {
  return frame.event.eventId ?? -1n;
}

async function take(
  frames: AsyncGenerator<LiveFrame>,
  count: number,
): Promise<LiveFrame[]> {
  const taken: LiveFrame[] = [];
  while (taken.length < count) {
    const next = await frames.next();
    if (next.done) break;
    taken.push(next.value);
  }
  return taken;
}

describe("subscribeAll under a burst", () => {
  it("hands item and edge events on in publish order when the consumer has not drained", async () => {
    const controller = new AbortController();
    const frames = subscribeAll({ signal: controller.signal });
    // The generator attaches its listeners on its first `next()`, so the
    // first take is issued before the burst and settles on its first
    // frame; the rest of the burst queues behind it untaken.
    const first = frames.next();

    const burst: PubsubEventWithId[] = [
      itemEvent(1),
      edgeEvent(2),
      itemEvent(3),
      itemEvent(4),
      edgeEvent(5),
      edgeEvent(6),
      itemEvent(7),
    ];
    for (const event of burst) emitWake(event);

    const head = await first;
    expect(head.done).toBe(false);
    const rest = await take(frames, burst.length - 1);
    const all = [head.value as LiveFrame, ...rest];
    expect(all.map(idOf)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(all.map((frame) => frame.kind)).toEqual([
      "item",
      "edge",
      "item",
      "item",
      "edge",
      "edge",
      "item",
    ]);

    controller.abort();
    await frames.return(undefined);
  });

  it("keeps the order across a type filter that drops part of the burst", async () => {
    const controller = new AbortController();
    const frames = subscribeAll({
      signal: controller.signal,
      typeFilter: "core.note",
    });
    const first = frames.next();

    emitWake(itemEvent(1));
    emitWake(itemEvent(2, "core.task"));
    emitWake(edgeEvent(3));
    emitWake(itemEvent(4));

    const head = await first;
    const rest = await take(frames, 2);
    expect([head.value as LiveFrame, ...rest].map(idOf)).toEqual([1n, 3n, 4n]);

    controller.abort();
    await frames.return(undefined);
  });

  it("takes both listeners off the bus when it is closed", async () => {
    const before = __listenerCountForTests();
    const frames = subscribeAll();
    const first = frames.next();
    // Attached, and the count is the witness that closing has something
    // to remove.
    expect(__listenerCountForTests()).toBe(before + 2);

    emitWake(itemEvent(1));
    await first;
    await frames.return(undefined);
    expect(__listenerCountForTests()).toBe(before);
  });

  it("takes both listeners off the bus when its signal aborts", async () => {
    const before = __listenerCountForTests();
    const controller = new AbortController();
    const frames = subscribeAll({ signal: controller.signal });
    const first = frames.next();
    expect(__listenerCountForTests()).toBe(before + 2);

    controller.abort();
    expect((await first).done).toBe(true);
    expect(__listenerCountForTests()).toBe(before);
  });
});
