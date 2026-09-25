import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import {
  collectUntil,
  withStream,
  MUTATION_EVENT_NAMES,
} from "../../utils/stream.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "A replay is what a live subscriber would have seen": what a subscription
 * promises about where it starts and about what it carries.
 *
 * Both cases here are about a client believing it is current when it is not,
 * and neither produces an error at any point.
 *
 * Hydration subscribes before it reads, so that a write landing between the
 * two arrives as an event rather than being missed. That ordering only works
 * if the client can say which point its read is relative to — and the only
 * party that knows is the server, at the moment it opens the stream. Without
 * an announcement the client has to invent one: resume from nothing and
 * replay a backlog it has already read, or resume from the first event it
 * happens to see and lose whatever preceded it.
 *
 * A filtered subscription is the same failure with a narrower blast radius. A
 * client that subscribes to the types it holds and is sent no edge events
 * keeps a graph that decays quietly: edges it holds are gone, edges it does
 * not hold exist, and every item in the listing is correct.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "stream-contract",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
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
  expect(created.ok).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

/** Every item id named by any frame in a set. */
function itemIds(events: { data: unknown }[]): Set<string> {
  return new Set(
    events
      .map((e) => (e.data as { item?: { id?: string } })?.item?.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

describe("the stream announces where it starts", () => {
  it("announces a cursor a client can resume from", async (context) => {
    requireRule(caps, "announcedCursor");

    // Written before the subscription opens. It is the control: the announced
    // cursor is meant to be the log's *current* position, so a resume from it
    // must not bring this back. A server announcing a zero or an empty value
    // would replay it and fail here.
    const before = await makeNote("announced-cursor-before");

    const opened = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      // A write made after the subscription opens, and what turns the absence
      // below into an observation. An announcement names the point the stream
      // starts from, so it can only precede the first event that stream
      // delivers; once this write's frame has arrived, an announcement that
      // was going to come has come. Reading to a quiet window instead would
      // report a missing announcement for a stream that was merely slow, and
      // it is also the control: a stream that never delivers this fails here
      // rather than answering.
      const probe = await makeNote("announced-cursor-probe");
      const { events } = await collectUntil(
        stream,
        (evts) => itemIds(evts).has(probe),
        `item.created for the probe write ${probe}`,
        context.signal,
      );
      const frame = events.find(
        (e) =>
          !MUTATION_EVENT_NAMES.has(e.event) && e.event !== "catchup_too_old",
      );
      expect(
        frame,
        `a fresh connection sent no frame announcing its position, so a client cannot say which point its hydrating read is relative to (saw: ${events.map((e) => e.event).join(", ") || "no typed events"})`,
      ).toBeDefined();
      return { frame: frame!, probe, events };
    });
    const { frame: announced, probe, events: firstRead } = opened;

    // Whatever the frame is called, the value has to be usable as a resume
    // point. Asserting on the frame's name or shape would pin an announcement
    // that says nothing; asserting that it resumes is the rule.
    const cursor =
      (announced.data as { cursor?: unknown })?.cursor ?? announced.id;
    expect(
      typeof cursor === "string" || typeof cursor === "number",
      `the announcement carried no cursor value to resume from: ${JSON.stringify(announced.data)}`,
    ).toBe(true);

    const after = await makeNote("announced-cursor-after");
    // Written last, so the resumed read ends on a frame rather than on
    // silence. Both assertions below are about what the backlog contains, and
    // a read that stopped early satisfies the first one and fails the second
    // for a reason that has nothing to do with the cursor.
    const sentinel = await makeNote("announced-cursor-sentinel");

    const { events } = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: String(cursor) },
      (stream) =>
        collectUntil(
          stream,
          (evts) => itemIds(evts).has(sentinel),
          `the resumed stream to reach the sentinel ${sentinel}`,
          context.signal,
        ),
    );
    const replayed = itemIds(events);

    expect(
      replayed.has(before),
      "resuming from the announced cursor replayed a write that preceded the announcement, so the value is not the position the stream was at",
    ).toBe(false);
    expect(
      replayed.has(after),
      "resuming from the announced cursor missed a write made after it, so a client hydrating from that point has a hole it will never learn about",
    ).toBe(true);
    // The probe was the first write after the announcement, so it is the
    // one a cursor announced one too high would skip: a resume that
    // carries the later write and not this one has named a position past
    // the head rather than at it.
    expect(
      replayed.has(probe),
      "resuming from the announced cursor missed the first write after it, so the announcement names a position past the head",
    ).toBe(true);
    // And every id the first stream delivered live above the cursor, not
    // the probe alone: in a run where another fixture writes between the
    // head read and the probe, a cursor one too high skips that write
    // and the probe still arrives.
    const cursorId = BigInt(String(cursor));
    const resumedIds = new Set(
      events
        .map((e) => e.id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    );
    const liveAboveCursor = firstRead
      .map((e) => e.id)
      .filter((id): id is string => typeof id === "string" && id !== "")
      .filter((id) => BigInt(id) > cursorId);
    expect(
      liveAboveCursor.length,
      "the first stream delivered no id above the announced cursor",
    ).toBeGreaterThan(0);
    for (const id of liveAboveCursor) {
      expect(
        resumedIds.has(id),
        `the resumed read missed event ${id}, which the first stream delivered above the announced cursor ${String(cursorId)}`,
      ).toBe(true);
    }
  });
});

describe("a filtered stream carries the graph", () => {
  it("delivers edge events to a stream filtered by item type", async (context) => {
    requireRule(caps, "edgeEventsUnderFilter");

    const outcome = await withStream(
      apiUrl,
      apiKey,
      { query: [["type", "core.note"]] },
      async (stream) => {
        // Let the subscription settle, or the writes below are published to
        // nobody and every absence in this test is about timing.
        await new Promise((r) => setTimeout(r, 250));

        const source = await client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: "filtered-edge-source" },
        });
        const target = await client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: "filtered-edge-target" },
        });
        expect(source.ok && target.ok).toBe(true);
        trackItem(ctx, source.data.item.id);
        trackItem(ctx, target.data.item.id);

        // The exclusion control. A filter that admits everything would pass
        // the edge assertion below without filtering at all, and a reader
        // would take a stream with no filtering for a filter that is truthful
        // about edges.
        const unrelated = await client.createItem({
          type: "core.task",
          source: ctx.source,
          properties: { title: "filtered-edge-unrelated" },
        });
        expect(
          unrelated.ok,
          `the control item could not be created: ${JSON.stringify(unrelated.error)}`,
        ).toBe(true);
        trackItem(ctx, unrelated.data.item.id);

        const edge = await client.createEdge({
          source_id: source.data.item.id,
          target_id: target.data.item.id,
          edge_type: "about",
        });
        expect(edge.ok).toBe(true);
        trackEdge(ctx, edge.data.edge.id);

        // A sentinel note written after the edge. The stream delivers both
        // kinds in id order, so its frame arriving is proof the edge's
        // frame, published before it, has arrived or was withheld; and a
        // note passes the filter whatever the answer about edges is, so a
        // server withholding edges still ends the read with a finding
        // rather than a timeout that names the wrong thing.
        const sentinel = await client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: "filtered-edge-sentinel" },
        });
        expect(sentinel.ok).toBe(true);
        trackItem(ctx, sentinel.data.item.id);
        const seen = await collectUntil(
          stream,
          (events) => itemIds(events).has(sentinel.data.item.id),
          `item.created for the sentinel note ${sentinel.data.item.id}`,
          context.signal,
        );
        return {
          events: seen.events,
          edgeId: edge.data.edge.id,
          unrelatedId: unrelated.data.item.id,
        };
      },
    );

    expect(
      itemIds(outcome.events).has(outcome.unrelatedId),
      "a stream filtered to core.note delivered a core.task, so it is not filtering and the assertion below would mean nothing",
    ).toBe(false);

    const edgeIds = new Set(
      outcome.events
        .map((e) => (e.data as { edge?: { id?: string } })?.edge?.id)
        .filter((id): id is string => typeof id === "string"),
    );
    expect(
      edgeIds.has(outcome.edgeId),
      "a stream filtered by item type dropped the edge between two items it did deliver, so a filtered client's graph goes stale with nothing to say so",
    ).toBe(true);
  });
});
