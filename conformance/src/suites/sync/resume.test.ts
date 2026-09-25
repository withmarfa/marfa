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
 * A reader that closes and comes back later.
 *
 * A connector reads the log this way: it opens the stream on each run,
 * reads until it has seen what it came for, closes, and on its next run
 * resumes from the last id it received. That is a sound cursor only if
 * the stream delivers ids in order, replayed and live alike: a frame with
 * a lower id that reached the client after a higher one sits behind a
 * cursor already past it, and nothing ever replays it. An edge frame is
 * the one that can fall behind, since it waits on a read before it is
 * sent. The gap closes silently, which is why it is asserted rather than
 * assumed.
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

/**
 * Every edge frame in a set, as `<event>:<edge id>`. Per frame rather
 * than per edge, because an edge that was created and then deleted has
 * two frames, and a read that carried the first and lost the second
 * would still name the edge.
 */
function edgeFrames(events: SseEvent[]): Set<string> {
  return new Set(
    events
      .map((e) => {
        const id = (e.data as { edge?: { id?: string } })?.edge?.id;
        return typeof id === "string" ? `${e.event}:${id}` : undefined;
      })
      .filter((key): key is string => key !== undefined),
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

    // Writes issued while the stream is open, an edge among them and a
    // purge last. A purge announces every edge of the row before the row,
    // and an edge frame waits on a read before it is sent, which is where
    // a frame published after it could overtake it. The first read ends
    // on the purge's own frame, so it carries live frames of both kinds
    // past the head it was announced, and the last id it received is the
    // cursor the second read resumes from. Whichever side of the head
    // each write lands on, it has to arrive exactly once across the two.
    let during: string[] = [];
    let duringEdge = "";
    let doomed = "";
    const doomedEdges: string[] = [];
    const first = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId },
      async (stream) => {
        const [one, edge, two] = await Promise.all([
          makeNote("resume-during-1"),
          makeEdge(before[0]!, before[1]!),
          makeNote("resume-during-2"),
        ]);
        during = [one, two];
        duringEdge = edge;
        // The row is gone by the time the reads are judged, so neither it
        // nor its edges are tracked for teardown.
        const created = await client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: "resume-purged" },
        });
        expect(created.ok, "the row to purge could not be created").toBe(true);
        doomed = created.data.item.id;
        for (const target of [before[2]!, before[3]!]) {
          const made = await client.createEdge({
            source_id: doomed,
            target_id: target,
            edge_type: "about",
          });
          expect(made.ok, "an edge of the row to purge failed").toBe(true);
          doomedEdges.push(made.data.edge.id);
        }
        const trashed = await client.deleteItem(doomed);
        expect(trashed.ok, "the row could not be trashed").toBe(true);
        const purged = await client.purgeItem(doomed);
        expect(purged.ok, "the row could not be purged").toBe(true);

        const { events } = await collectUntil(
          stream,
          (evts) =>
            evts.some(
              (e) =>
                e.event === "item.purged" &&
                (e.data as { item?: { id?: string } })?.item?.id === doomed,
            ),
          `the purge of ${doomed} to reach the stream`,
          context.signal,
        );
        return events;
      },
    );

    const firstIds = eventIds(first);
    const head = announcedHead(first);
    expect(head, "the first read was not announced a head").toBeDefined();
    expect(
      firstIds.length,
      "the first read reached the purge without receiving an event with an id",
    ).toBeGreaterThan(0);
    // The witness that the first read went past its replay: it received
    // ids above the head it was announced, which only live delivery
    // carries.
    expect(
      firstIds.some((id) => id > head!),
      `the first read received no id past the announced head ${String(head!)}, so it never left the replay`,
    ).toBe(true);
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
    for (const id of [...before, ...during, doomed, ...after]) {
      expect(
        seenFirst.has(id) || seenSecond.has(id),
        `the item ${id} was delivered by neither read, so a reader resuming from the last id it received has a gap it will never learn about`,
      ).toBe(true);
    }
    // Every edge frame the writes produced, each in exactly one read: the
    // purged row's edges were announced twice, created and then deleted,
    // and the deletions are the frames a row's purge overtakes.
    const framesFirst = edgeFrames(first);
    const framesSecond = edgeFrames(second);
    const expected = [
      `edge.created:${duringEdge}`,
      ...doomedEdges.map((id) => `edge.created:${id}`),
      ...doomedEdges.map((id) => `edge.deleted:${id}`),
      `edge.created:${afterEdge}`,
    ];
    for (const frame of expected) {
      expect(
        framesFirst.has(frame) || framesSecond.has(frame),
        `the frame ${frame} was delivered by neither read, so an edge frame fell behind the cursor`,
      ).toBe(true);
      expect(
        framesFirst.has(frame) && framesSecond.has(frame),
        `the frame ${frame} was delivered by both reads`,
      ).toBe(false);
    }
  });
});
