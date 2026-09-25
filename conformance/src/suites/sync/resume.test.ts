import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import type { SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

/**
 * A reader that closes at the head and comes back later.
 *
 * A connector reads the log this way: it opens the stream on each run,
 * takes the head the first frame announces, reads until it has seen an id
 * at or past it, closes, and on its next run resumes from the last id it
 * received. That is a sound cursor only if ids are issued in commit order:
 * an event with an id below the head that committed after the head was
 * announced would sit behind a cursor already past it, and nothing would
 * ever replay it. The gap closes silently, which is why it is asserted
 * rather than assumed.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext("sync", "resume"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeNote(body: string): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body },
  });
  expect(created.ok, `the note could not be created: ${body}`).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

async function makeEdge(source: string, target: string): Promise<string> {
  const created = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: "about",
  });
  expect(
    created.ok,
    `the edge could not be created: ${JSON.stringify(created.error)}`,
  ).toBe(true);
  trackEdge(ctx, created.data.edge.id);
  return created.data.edge.id;
}

/** Every item id named by any frame in a set. */
function itemIds(events: SseEvent[]): Set<string> {
  return new Set(
    events
      .map((e) => (e.data as { item?: { id?: string } })?.item?.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** Every edge id named by any frame in a set. */
function edgeIds(events: SseEvent[]): Set<string> {
  return new Set(
    events
      .map((e) => (e.data as { edge?: { id?: string } })?.edge?.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** The frames' ids read strictly ascending, or the read is not in order. */
function expectAscending(ids: bigint[], read: string): void {
  for (let i = 1; i < ids.length; i += 1) {
    expect(
      ids[i]! > ids[i - 1]!,
      `the ${read} read delivered ids out of order: ${ids.join(", ")}`,
    ).toBe(true);
  }
}

/** The ids the frames carry, as the log numbers them. */
function eventIds(events: SseEvent[]): bigint[] {
  return events
    .map((e) => e.id)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map((id) => BigInt(id));
}

/** The head the stream announced, once it has. */
function announcedHead(events: SseEvent[]): bigint | undefined {
  const frame = events.find((e) => e.event === "stream_cursor");
  const cursor = (frame?.data as { cursor?: unknown } | undefined)?.cursor;
  return typeof cursor === "string" ? BigInt(cursor) : undefined;
}

describe("resuming from the head", () => {
  it("a reader that closes at the head and resumes from its last id misses nothing and repeats nothing", async (context) => {
    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => makeNote("resume-marker"),
      context.signal,
    );

    // Written before the first read, so they sit between the cursor and
    // the head that read will be announced.
    const before: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      before.push(await makeNote(`resume-before-${String(n)}`));
    }

    // Writes issued while the stream is opening and replaying, an edge
    // among them: an edge frame waits on a read before it is sent, which
    // is where an item frame published after it could overtake it.
    // Whichever side of the announced head each lands on, it has to
    // arrive exactly once across the two reads.
    let during: string[] = [];
    let duringEdge = "";
    const first = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId },
      async (stream) => {
        const racing = Promise.all([
          makeNote("resume-during-1"),
          makeEdge(before[0]!, before[1]!),
          makeNote("resume-during-2"),
        ]);
        let events: SseEvent[];
        try {
          ({ events } = await collectUntil(
            stream,
            (evts) => {
              const head = announcedHead(evts);
              return (
                head !== undefined && eventIds(evts).some((id) => id >= head)
              );
            },
            "the replay to reach the announced head",
            context.signal,
          ));
        } finally {
          // Settled either way, so a read that failed does not leave the
          // racing writes rejecting into nothing.
          const [one, edge, two] = await racing;
          during = [one, two];
          duringEdge = edge;
        }
        return events;
      },
    );

    const firstIds = eventIds(first);
    expect(
      firstIds.length,
      "the first read reached the head without receiving an event with an id",
    ).toBeGreaterThan(0);
    expectAscending(firstIds, "first");
    // The control: a resume that honors `Last-Event-ID` does not carry the
    // event at the cursor itself.
    expect(
      itemIds(first).has(markerId),
      "the first read carried the event at the cursor, so it is not resuming from it",
    ).toBe(false);
    const lastReceived = firstIds[firstIds.length - 1]!;

    // Written after the first read closed, so they are what the resume
    // exists to fetch. The last is the sentinel the second read ends on.
    const afterEdge = await makeEdge(before[2]!, before[3]!);
    const after = [
      await makeNote("resume-after-1"),
      await makeNote("resume-after-2"),
    ];
    const sentinel = after[after.length - 1]!;

    const second = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: String(lastReceived) },
      (stream) =>
        collectUntil(
          stream,
          (evts) => itemIds(evts).has(sentinel),
          `the resumed read to reach the sentinel ${sentinel}`,
          context.signal,
        ).then((result) => result.events),
    );

    const secondIds = eventIds(second);
    expectAscending(secondIds, "resumed");
    for (const id of secondIds) {
      expect(
        id > lastReceived,
        `the resumed read carried id ${String(id)}, at or below the cursor ${String(lastReceived)}`,
      ).toBe(true);
    }

    // Once each across the two reads, and once within a read: a frame
    // sent twice under one id would pass a check that only looked across.
    const delivered = new Map<bigint, number>();
    for (const id of [...firstIds, ...secondIds]) {
      delivered.set(id, (delivered.get(id) ?? 0) + 1);
    }
    for (const [id, times] of delivered) {
      expect(
        times,
        `the event ${String(id)} was delivered ${String(times)} times`,
      ).toBe(1);
    }
    const seenFirst = itemIds(first);
    const seenSecond = itemIds(second);
    for (const id of [...before, ...during, ...after]) {
      expect(
        seenFirst.has(id) || seenSecond.has(id),
        `the item ${id} was delivered by neither read, so a reader resuming from the last id it received has a gap it will never learn about`,
      ).toBe(true);
    }
    const edgesFirst = edgeIds(first);
    const edgesSecond = edgeIds(second);
    for (const id of [duringEdge, afterEdge]) {
      expect(
        edgesFirst.has(id) || edgesSecond.has(id),
        `the edge ${id} was delivered by neither read, so an edge frame fell behind the cursor`,
      ).toBe(true);
      expect(
        edgesFirst.has(id) && edgesSecond.has(id),
        `the edge ${id} was delivered by both reads`,
      ).toBe(false);
    }
  });
});
