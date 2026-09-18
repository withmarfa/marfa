import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackType,
  cleanup,
} from "../../utils/setup.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

/**
 * "A replay is what a live subscriber would have seen": what a reconnecting
 * client reads out of the log has to be what a connected client was sent.
 *
 * Both cases here are about a gap that closes silently. A client resumes from
 * its cursor, receives a backlog, applies it and believes it is caught up. If
 * the replay path resolves a filter differently from the live path, or if a
 * write never reached the log to be replayed, the client is missing rows and
 * has no way to know — nothing errors, and the next reconnect replays the same
 * incomplete backlog. Only a full re-import recovers it, and nothing asks for
 * one.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let childType: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext("sync", "replay"));
  childType = `user.${ctx.runId}-replay-child`;
  const registered = await client.registerType({
    id: childType,
    parent: "core.note",
    fields: {},
  });
  expect(
    registered.ok,
    `could not register the subtype: ${JSON.stringify(registered.error)}`,
  ).toBe(true);
  trackType(ctx, childType, client);
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Every item id named by any frame in a set. */
function itemIds(events: { data: unknown }[]): Set<string> {
  return new Set(
    events
      .map((e) => (e.data as { item?: { id?: string } })?.item?.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

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

describe("replay", () => {
  it("resolves a type filter through the same subtree the live stream does", async (context) => {
    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => makeNote("replay-subtype-marker"),
      context.signal,
    );
    trackItem(ctx, markerId);

    // A descendant of the filtered type, and a control that is not one.
    const child = await client.createItem({
      type: childType,
      source: ctx.source,
      properties: { body: "replay-subtype-child" },
    });
    expect(child.ok).toBe(true);
    trackItem(ctx, child.data.item.id);

    const unrelated = await client.createItem({
      type: "core.task",
      source: ctx.source,
      properties: { title: "replay-subtype-unrelated" },
    });
    expect(
      unrelated.ok,
      `the control item could not be created: ${JSON.stringify(unrelated.error)}`,
    ).toBe(true);
    trackItem(ctx, unrelated.data.item.id);

    // Written last, and the only reason this read can end on an observation.
    // A replay is a scan of the log from the resume point, and every row above
    // was committed before the subscription opened, so a sentinel that has
    // arrived is proof the scan passed everything ahead of it. Reading to a
    // quiet window instead would make a slow page and a dropped row the same
    // result, and the case would then report a filter defect for a pause.
    const sentinel = await makeNote("replay-subtype-sentinel");

    const { events } = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId, query: [["type", "core.note"]] },
      (stream) =>
        collectUntil(
          stream,
          (evts) => itemIds(evts).has(sentinel),
          `the replay to reach the sentinel ${sentinel}`,
          context.signal,
        ),
    );
    const replayedIds = itemIds(events);

    // The control. A filter that admits everything would pass the assertion
    // below without resolving anything, so the unrelated type has to be
    // absent for the presence of the child to mean the subtree was resolved.
    expect(
      replayedIds.has(unrelated.data.item.id),
      "the type filter admitted an unrelated type, so it is not filtering",
    ).toBe(false);

    expect(
      replayedIds.has(child.data.item.id),
      `a ${childType} item is a core.note by inheritance and was dropped from a core.note replay`,
    ).toBe(true);
  });

  it("carries a bulk write, so a catch-up after an import is complete", async (context) => {
    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => makeNote("replay-bulk-marker"),
      context.signal,
    );
    trackItem(ctx, markerId);

    // `enable_fanout: false` is the point of the case, not a detail. The flag
    // governs outbound work — webhook delivery and reactive runs — and never
    // whether the write is recorded. A server that read it as "do not publish"
    // would drop these rows from the log, and the only client that notices is
    // one catching up after an import: the rows are all there on a full read,
    // and absent from every replay for ever.
    const bulk = await client.bulkItems({
      enable_fanout: false,
      items: [
        {
          type: "core.note",
          source: ctx.source,
          properties: { body: "replay-bulk-one" },
        },
        {
          type: "core.note",
          source: ctx.source,
          properties: { body: "replay-bulk-two" },
        },
      ],
    });
    expect(
      bulk.ok,
      `the bulk write was refused: ${JSON.stringify(bulk.error)}`,
    ).toBe(true);
    // Recorded off the write rather than by reading a listing back. A bulk
    // response reports outcomes rather than items, so an extraction that
    // assumes the single-create shape silently records nothing and the rows
    // outlive the run.
    const bulkIds = bulk.data.results
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string");
    for (const id of bulkIds) trackItem(ctx, id);
    // Before anything else, because an entry the server skipped or refused
    // carries no id: a short list here means rows were not written, and every
    // assertion below would then be reporting on a write that never happened.
    expect(
      bulkIds,
      `the bulk write did not create two rows: ${JSON.stringify(bulk.data.results)}`,
    ).toHaveLength(2);

    // Written last, for the reason the sibling case gives.
    const sentinel = await makeNote("replay-bulk-sentinel");

    const { events } = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId },
      (stream) =>
        collectUntil(
          stream,
          (evts) => itemIds(evts).has(sentinel),
          `the replay to reach the sentinel ${sentinel}`,
          context.signal,
        ),
    );
    const replayedIds = itemIds(events);

    // The control. A replay that ignored `Last-Event-ID` and dumped the whole
    // log would contain the bulk rows for the wrong reason, so the marker
    // written immediately before the resume point must not be in the backlog.
    expect(
      replayedIds.has(markerId),
      "the replay carried an event at or before the resume point, so it is not honoring Last-Event-ID",
    ).toBe(false);

    for (const id of bulkIds) {
      expect(
        replayedIds.has(id),
        `a bulk-written item (${id}) never reached the event log, so a client catching up after an import is silently short`,
      ).toBe(true);
    }
  });
});
