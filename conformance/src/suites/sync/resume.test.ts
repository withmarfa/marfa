import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
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

/** Every item id named by any frame in a set. */
function itemIds(events: SseEvent[]): Set<string> {
  return new Set(
    events
      .map((e) => (e.data as { item?: { id?: string } })?.item?.id)
      .filter((id): id is string => typeof id === "string"),
  );
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

    // Writes issued while the stream is opening and replaying. Whichever
    // side of the announced head each lands on, it has to arrive exactly
    // once across the two reads.
    let during: string[] = [];
    const first = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId },
      async (stream) => {
        const racing = Promise.all([
          makeNote("resume-during-1"),
          makeNote("resume-during-2"),
        ]);
        const { events } = await collectUntil(
          stream,
          (evts) => {
            const head = announcedHead(evts);
            return (
              head !== undefined && eventIds(evts).some((id) => id >= head)
            );
          },
          "the replay to reach the announced head",
          context.signal,
        );
        during = await racing;
        return events;
      },
    );

    const firstIds = eventIds(first);
    expect(
      firstIds.length,
      "the first read reached the head without receiving an event with an id",
    ).toBeGreaterThan(0);
    for (let i = 1; i < firstIds.length; i += 1) {
      expect(
        firstIds[i]! > firstIds[i - 1]!,
        `the first read delivered ids out of order: ${firstIds.join(", ")}`,
      ).toBe(true);
    }
    // The control: a resume that honors `Last-Event-ID` does not carry the
    // event at the cursor itself.
    expect(
      itemIds(first).has(markerId),
      "the first read carried the event at the cursor, so it is not resuming from it",
    ).toBe(false);
    const lastReceived = firstIds[firstIds.length - 1]!;

    // Written after the first read closed, so they are what the resume
    // exists to fetch. The last is the sentinel the second read ends on.
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
    for (const id of secondIds) {
      expect(
        id > lastReceived,
        `the resumed read carried id ${String(id)}, at or below the cursor ${String(lastReceived)}`,
      ).toBe(true);
    }

    const seenFirst = itemIds(first);
    const seenSecond = itemIds(second);
    for (const id of seenSecond) {
      expect(
        seenFirst.has(id),
        `the item ${id} was delivered by both reads, so the cursor repeats an event`,
      ).toBe(false);
    }
    for (const id of [...before, ...during, ...after]) {
      expect(
        seenFirst.has(id) || seenSecond.has(id),
        `the item ${id} was delivered by neither read, so a reader resuming from the last id it received has a gap it will never learn about`,
      ).toBe(true);
    }
  });
});
