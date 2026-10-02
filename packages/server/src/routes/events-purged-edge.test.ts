/**
 * Purging an item tells a subscriber about its edges only where it could
 * have read the item.
 *
 * A purge announces each edge it took after the row has gone, so a stream
 * that looked the source up found nothing and showed the frame to every
 * subscriber holding the edge type. The event carries the source's type
 * from the moment it was published instead, and the stream decides on
 * that, live and on a replay alike.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  readSse,
  request,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

let ctx: TestContext;
let narrow: string;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  // Every edge type, and notes but not bookmarks.
  narrow = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read" },
    edge_permissions: { "*": "read" },
    extension_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    permissions: [],
  });
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function create(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** A bookmark with an edge to a note, purged; then a note as sentinel.
 *  Answers the edge's id and the sentinel's marker. */
async function purgeABookmarkWithAnEdge(
  label: string,
): Promise<{ edgeId: string; sentinel: string }> {
  const bookmark = await create("core.bookmark", { title: `bm-${label}` });
  const target = await create("core.note", { body: `target-${label}` });
  const edgeRes = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id: bookmark, target_id: target, edge_type: "references" },
  });
  expect(edgeRes.status).toBe(201);
  const edgeId = ((await edgeRes.json()) as { edge: { id: string } }).edge.id;
  expect(
    (
      await request(ctx.app, "DELETE", `/items/${bookmark}`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(ctx.app, "DELETE", `/items/${bookmark}/purge`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
  const sentinel = `ZZsentinel-${label}ZZ`;
  await create("core.note", { body: sentinel });
  return { edgeId, sentinel };
}

/** The `edge.deleted` frame naming this edge, or null. */
function deletedFrame(text: string, edgeId: string): string | null {
  return (
    text
      .split("\n\n")
      .find(
        (frame) =>
          frame.includes("event: edge.deleted") && frame.includes(edgeId),
      ) ?? null
  );
}

describe("a purged item's edges on the stream", () => {
  it("reach a subscriber that could read the item, and not one that could not", async () => {
    const wide = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    const narrowed = await request(ctx.app, "GET", "/events", { key: narrow });
    await settle();
    const { edgeId, sentinel } = await purgeABookmarkWithAnEdge("live");

    const { text: wideText } = await readSse(wide, {
      until: (seen) => seen.includes(sentinel),
    });
    // The witness: the purge did announce the edge, naming its source.
    const frame = deletedFrame(wideText, edgeId);
    expect(frame).not.toBeNull();
    expect(frame).toContain('"source_type":"core.bookmark"');
    expect(frame).toContain('"purged_with"');

    const { text: narrowText } = await readSse(narrowed, {
      until: (seen) => seen.includes(sentinel),
    });
    expect(
      deletedFrame(narrowText, edgeId),
      "a subscriber that may not read bookmarks was told about a purged bookmark's edge",
    ).toBeNull();
  });

  it("are withheld the same way on a replay from a cursor", async () => {
    const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    const { edgeId, sentinel } = await purgeABookmarkWithAnEdge("replay");

    const replay = async (key: string): Promise<string> => {
      const res = await request(ctx.app, "GET", "/events", {
        key,
        headers: { "Last-Event-ID": String(cursor) },
      });
      return (await readSse(res, { until: (seen) => seen.includes(sentinel) }))
        .text;
    };
    expect(deletedFrame(await replay(ctx.workingKey), edgeId)).not.toBeNull();
    expect(deletedFrame(await replay(narrow), edgeId)).toBeNull();
  });
});
