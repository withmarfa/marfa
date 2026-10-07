import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";
import { openEventStream, type SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";
import {
  expectSignedBy,
  startReceiver,
  type Received,
  type Receiver,
} from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "edge-events",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

async function makeItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `evt-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge events", () => {
  it("SSE delivers edge.created and edge.deleted", async ({ signal }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      // Let the subscription settle before the writes it is meant to observe.
      await new Promise((r) => setTimeout(r, 200));
      const src = await makeItem("sse-src");
      const tgt = await makeItem("sse-tgt");
      const edge = await client.createEdge({
        source_id: src,
        target_id: tgt,
        edge_type: "about",
      });
      expect(edge.ok).toBe(true);
      const ourEdgeId = edge.data.edge.id;
      expect((await client.deleteEdge(ourEdgeId)).ok).toBe(true);

      const isOurs = (e: SseEvent, name: string): boolean =>
        e.event === name &&
        (e.data as { edge?: { id?: string } }).edge?.id === ourEdgeId;
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some((e) => isOurs(e, "edge.created")) &&
          evts.some((e) => isOurs(e, "edge.deleted")),
        `edge.created and edge.deleted for ${ourEdgeId}`,
        signal,
      );
      const created = events.find((e) => isOurs(e, "edge.created"));
      const payload = created?.data as { edge?: { edge_type?: string } };
      expect(payload.edge?.edge_type).toBe("about");
    });
  });

  it("answers deletes of one edge after the first 404, and announces it once", async ({
    signal,
  }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 200));
      const src = await makeItem("double-delete-src");
      const tgt = await makeItem("double-delete-tgt");
      const edge = await client.createEdge({
        source_id: src,
        target_id: tgt,
        edge_type: "about",
      });
      expect(edge.ok).toBe(true);
      const edgeId = edge.data.edge.id;

      const deletes = await Promise.all(
        Array.from({ length: 8 }, () => client.deleteEdge(edgeId)),
      );
      expect(deletes.map((r) => r.status).sort()).toEqual([
        200, 404, 404, 404, 404, 404, 404, 404,
      ]);
      for (const refused of deletes.filter((r) => r.status === 404)) {
        expect(refused.error?.error.code).toBe("edge_not_found");
      }
      const again = await client.deleteEdge(edgeId);
      expect(again.status).toBe(404);
      expect(again.error?.error.code).toBe("edge_not_found");

      // A later write, so the stream has carried everything the deletes
      // announced once its frame arrives.
      const marker = await client.createEdge({
        source_id: tgt,
        target_id: src,
        edge_type: "about",
      });
      expect(marker.ok).toBe(true);
      trackEdge(ctx, marker.data.edge.id);
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              e.event === "edge.created" &&
              (e.data as { edge?: { id?: string } }).edge?.id ===
                marker.data.edge.id,
          ),
        `edge.created for ${marker.data.edge.id}`,
        signal,
      );
      const deleted = events.filter(
        (e) =>
          e.event === "edge.deleted" &&
          (e.data as { edge?: { id?: string } }).edge?.id === edgeId,
      );
      expect(deleted).toHaveLength(1);
    });
  });

  it("carries the source item's type on every edge frame", async ({
    signal,
  }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 200));
      const src = await makeItem("source-type-src");
      const tgt = await makeItem("source-type-tgt");
      const edge = await client.createEdge({
        source_id: src,
        target_id: tgt,
        edge_type: "about",
      });
      expect(edge.ok).toBe(true);
      const edgeId = edge.data.edge.id;
      expect((await client.deleteEdge(edgeId)).ok).toBe(true);
      const ours = (e: SseEvent): boolean =>
        e.event.startsWith("edge.") &&
        (e.data as { edge?: { id?: string } }).edge?.id === edgeId;
      const { events } = await collectUntil(
        stream,
        (evts) => evts.some((e) => ours(e) && e.event === "edge.deleted"),
        `edge.created and edge.deleted for ${edgeId}`,
        signal,
      );
      const frames = events.filter(ours);
      expect(frames.map((e) => e.event)).toEqual([
        "edge.created",
        "edge.deleted",
      ]);
      for (const frame of frames) {
        expect((frame.data as { source_type?: string }).source_type).toBe(
          "core.note",
        );
      }
    });
  });

  it("accepts writes while an event stream is open", async () => {
    // Every Marfa client holds a subscription open and writes through it,
    // so the two have to work together — testing them in isolation misses
    // the combination that actually ships. The failure this guards is a
    // deadlock in the calling HTTP client rather than a server stall: a
    // client that multiplexes the open subscription and the write onto one
    // connection can refuse to dispatch the write for as long as the
    // subscription lives, and the write then never departs the process at
    // all. Bound the wait explicitly so that failure reports as a slow
    // write rather than as an opaque whole-file timeout.
    const stream = await openEventStream(apiUrl, apiKey);
    expect(stream.response.status).toBe(200);
    try {
      const started = Date.now();
      const write = client.createItem(
        createNote({
          source: ctx.source,
          properties: { body: "evt-write-while-subscribed" },
        }),
      );
      const budgetMs = 30_000;
      const result = await Promise.race([
        write,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `write did not complete within ${budgetMs}ms while an event stream was open`,
                ),
              ),
            budgetMs,
          ),
        ),
      ]);
      expect(result.ok).toBe(true);
      trackItem(ctx, result.data.item.id);
      expect(Date.now() - started).toBeLessThan(budgetMs);
    } finally {
      await stream.close();
    }
  });

  it("delivers edge.created and edge.deleted to a webhook with a valid signature", async () => {
    const subscription = await client.createWebhook({
      url: receiver.hookUrl("edges"),
      events: ["edge.created", "edge.deleted"],
    });
    expect(subscription.status).toBe(201);
    trackWebhook(ctx, subscription.data.id, client);

    const src = await makeItem("hook-src");
    const tgt = await makeItem("hook-tgt");
    const edge = await client.createEdge({
      source_id: src,
      target_id: tgt,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    const edgeId = edge.data.edge.id;
    expect((await client.deleteEdge(edgeId)).ok).toBe(true);

    const forOurEdge = (name: string) => (r: Received) =>
      r.path === "/hook/edges" &&
      r.headers["x-marfa-event-type"] === name &&
      r.body.includes(edgeId);
    const created = await receiver.waitFor(forOurEdge("edge.created"));
    const deleted = await receiver.waitFor(forOurEdge("edge.deleted"));
    for (const delivery of [created, deleted]) {
      expectSignedBy(delivery, subscription.data.secret);
    }
    const payload = JSON.parse(created.body) as {
      event_type: string;
      edge: { id: string; edge_type: string };
    };
    expect(payload.event_type).toBe("edge.created");
    expect(payload.edge.id).toBe(edgeId);
    expect(payload.edge.edge_type).toBe("about");

    const rows = await client.listWebhookDeliveries(subscription.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.data.map((d) => d.event_type).sort()).toEqual([
      "edge.created",
      "edge.deleted",
    ]);
    expect(rows.data.data.every((d) => d.succeeded)).toBe(true);
  });

  it("audit log records edge mutations with edge_id in resource_id", async () => {
    const src = await makeItem("audit-src");
    const tgt = await makeItem("audit-tgt");
    const edge = await client.createEdge({
      source_id: src,
      target_id: tgt,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const audit = await client.listAudit({
      resource_type: "edge",
      resource_id: edge.data.edge.id,
    });
    expect(audit.ok).toBe(true);
    const match = audit.data.data.find((r) => r.action === "edge.create");
    expect(match).toBeDefined();
    expect(match?.resource_type).toBe("edge");
    expect(match?.resource_id).toBe(edge.data.edge.id);
    expect(match?.details.edge_type).toBe("about");
  });

  it("answers a delete of an edge the key cannot read 404 edge_not_found and writes no audit record, where a delete it can read writes one", async () => {
    const narrow = await client.createKey({
      label: "audit-hidden-edge",
      source: `${ctx.source}-audit-hidden-edge`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { references: "write" },
    });
    expect(narrow.ok).toBe(true);
    trackKey(ctx, narrow.data.id);
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.data.key,
    });

    const note = await makeItem("audit-hidden-note");
    const other = await makeItem("audit-hidden-other");
    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.status).toBe(201);
    trackItem(ctx, bookmark.data.item.id);
    const place = async (source: string, target: string, edgeType: string) => {
      const r = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
      });
      expect(r.status).toBe(201);
      trackEdge(ctx, r.data.edge.id);
      return r.data.edge.id;
    };
    const actionsOn = async (id: string): Promise<string[]> => {
      const r = await client.listAudit({
        resource_type: "edge",
        resource_id: id,
      });
      expect(r.status).toBe(200);
      return r.data.data.map((row) => row.action);
    };
    // One edge hidden by its type and one by its source's type.
    const hiddenKind = await place(note, other, "about");
    const hiddenSource = await place(bookmark.data.item.id, note, "references");
    const readable = await place(note, other, "references");

    for (const [label, id] of [
      ["edge type", hiddenKind],
      ["source type", hiddenSource],
    ] as const) {
      const refused = await narrowClient.deleteEdge(id);
      expect(refused.status, label).toBe(404);
      expect(refused.error?.error.code, label).toBe("edge_not_found");
      // The edge is still there, and its audit trail is the create alone.
      expect((await client.getEdge(id)).status, label).toBe(200);
      expect(await actionsOn(id), label).toEqual(["edge.create"]);
    }

    // The witness: a delete the key can read answers 200 and writes one.
    expect((await narrowClient.deleteEdge(readable)).status).toBe(200);
    expect((await actionsOn(readable)).sort()).toEqual([
      "edge.create",
      "edge.delete",
    ]);
  });
});

/**
 * What a subscription discloses, against what the single read does.
 *
 * `?edges=none` was the only thing narrowing an edge frame, and a
 * subscriber's own parameter is not a permission: every authenticated
 * credential received every edge the instance wrote — both endpoints, the
 * kind of relationship and the properties on it — for rows
 * `GET /edges/{id}` refused it one at a time. The pair that door asks is
 * asked per subscriber now, on the live path and on the replay alike,
 * because a replayed frame is the same disclosure reached through a
 * cursor instead of a subscription.
 *
 * Each case writes three edges in one order and reads them back through
 * two credentials at once. The third is the sentinel and the witness in
 * one: edge frames reach a subscriber through a single pipeline, so a
 * later edge frame having arrived is proof that the two before it have
 * had their chance, and its presence is what makes their absence the gate
 * rather than an empty stream.
 */
describe("the stream answers only the edges a subscriber may read", () => {
  /** The three rows every case below is about, written in this order:
   *  one refused on its source's type, one on its own kind, and one the
   *  narrow credential may read. */
  async function writeTheThree(label: string): Promise<{
    seenKind: string;
    unseenKind: string;
    hiddenSource: string;
    hiddenKind: string;
    readable: string;
  }> {
    const seenKind = `mock.stream.${label}.seen.${ctx.runId}`;
    const unseenKind = `mock.stream.${label}.unseen.${ctx.runId}`;
    for (const id of [seenKind, unseenKind]) {
      const registered = await client.registerEdgeType({
        id,
        cardinality: "many-to-many",
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
      trackEdgeType(ctx, id);
    }
    const target = await makeItem(`${label}-target`);
    const readableSource = await makeItem(`${label}-readable-source`);
    const bookmark = await client.createItem(
      createBookmark({ properties: { title: `evt-${label}-hidden` } }),
    );
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const make = async (source: string, edgeType: string): Promise<string> => {
      const r = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      trackEdge(ctx, r.data.edge.id);
      return r.data.edge.id;
    };

    // Order matters: the readable row is written last, so a subscriber
    // that has received it has already been offered the two before it.
    const hiddenSource = await make(bookmark.data.item.id, seenKind);
    const hiddenKind = await make(readableSource, unseenKind);
    const readable = await make(readableSource, seenKind);
    return { seenKind, unseenKind, hiddenSource, hiddenKind, readable };
  }

  /** A credential reading notes and one kind of relationship. */
  async function narrowKey(label: string, seenKind: string): Promise<string> {
    const resp = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      edge_permissions: { [seenKind]: "read" },
    });
    expect(resp.ok, JSON.stringify(resp.error)).toBe(true);
    trackKey(ctx, resp.data.id);
    return resp.data.key;
  }

  function edgeIdsOf(events: SseEvent[]): string[] {
    return events
      .filter((e) => e.event.startsWith("edge."))
      .map((e) => (e.data as { edge?: { id?: string } }).edge?.id)
      .filter((id): id is string => id !== undefined);
  }

  it("withholds a live edge frame the credential could not read singly", async ({
    signal,
  }) => {
    const seenKind = `mock.stream.live.seen.${ctx.runId}`;
    const narrow = await narrowKey("stream-live-narrow", seenKind);

    await withStream(apiUrl, narrow, {}, async (narrowStream) => {
      await withStream(apiUrl, apiKey, {}, async (wideStream) => {
        // Let both subscriptions settle before the writes they are meant
        // to observe.
        await new Promise((r) => setTimeout(r, 300));
        const rows = await writeTheThree("live");
        expect(rows.seenKind).toBe(seenKind);

        const wide = await collectUntil(
          wideStream,
          (evts) => edgeIdsOf(evts).includes(rows.readable),
          `the readable edge ${rows.readable} on an unnarrowed stream`,
          signal,
        );
        const wideIds = edgeIdsOf(wide.events);
        expect(
          wideIds,
          "the write never reached the stream at all, so this case is not about permissions",
        ).toEqual(
          expect.arrayContaining([
            rows.hiddenSource,
            rows.hiddenKind,
            rows.readable,
          ]),
        );

        const seen = await collectUntil(
          narrowStream,
          (evts) => edgeIdsOf(evts).includes(rows.readable),
          `the readable edge ${rows.readable} on the narrowed stream`,
          signal,
        );
        const narrowIds = edgeIdsOf(seen.events);
        expect(
          narrowIds,
          "the subscriber was told about a relationship whose source is a type it may not read",
        ).not.toContain(rows.hiddenSource);
        expect(
          narrowIds,
          "the subscriber was told about a kind of relationship it may not read",
        ).not.toContain(rows.hiddenKind);
      });
    });
  });

  it("withholds the same frames on a replay from a cursor", async ({
    signal,
  }) => {
    const seenKind = `mock.stream.replay.seen.${ctx.runId}`;
    const narrow = await narrowKey("stream-replay-narrow", seenKind);

    // A point in the log before the writes. The marker is an ordinary
    // item, so the cursor is one the server minted rather than one this
    // file invented.
    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => makeItem("replay-marker"),
      signal,
    );
    trackItem(ctx, markerId);

    const rows = await writeTheThree("replay");
    expect(rows.seenKind).toBe(seenKind);

    // The unnarrowed replay first: every row is behind this cursor, so an
    // absence below is the credential and not the cursor.
    await withStream(apiUrl, apiKey, { lastEventId: eventId }, async (s) => {
      const { events } = await collectUntil(
        s,
        (evts) => edgeIdsOf(evts).includes(rows.readable),
        `the readable edge ${rows.readable} on an unnarrowed replay`,
        signal,
      );
      expect(edgeIdsOf(events)).toEqual(
        expect.arrayContaining([
          rows.hiddenSource,
          rows.hiddenKind,
          rows.readable,
        ]),
      );
    });

    await withStream(apiUrl, narrow, { lastEventId: eventId }, async (s) => {
      const { events } = await collectUntil(
        s,
        (evts) => edgeIdsOf(evts).includes(rows.readable),
        `the readable edge ${rows.readable} on the narrowed replay`,
        signal,
      );
      const ids = edgeIdsOf(events);
      expect(
        ids,
        "the catch-up handed back a relationship whose source is a type this credential may not read",
      ).not.toContain(rows.hiddenSource);
      expect(
        ids,
        "the catch-up handed back a kind of relationship this credential may not read",
      ).not.toContain(rows.hiddenKind);
    });
  });
  /** A bookmark with an edge to a note, trashed and purged, then a note as
   *  the sentinel. */
  async function purgeABookmarkWithAnEdge(
    label: string,
  ): Promise<{ edgeId: string; sentinel: string }> {
    const bookmark = await client.createItem(
      createBookmark({ properties: { title: `evt-${label}-purged` } }),
    );
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    const bookmarkId = bookmark.data.item.id;
    const target = await makeItem(`${label}-purged-target`);
    const edge = await client.createEdge({
      source_id: bookmarkId,
      target_id: target,
      edge_type: "references",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    expect((await client.deleteItem(bookmarkId)).ok).toBe(true);
    expect((await client.purgeItem(bookmarkId)).ok).toBe(true);
    const sentinel = await makeItem(`${label}-purged-sentinel`);
    return { edgeId: edge.data.edge.id, sentinel };
  }

  /** A credential reading notes and every kind of relationship. */
  async function notesOnlyKey(label: string): Promise<string> {
    const resp = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    expect(resp.ok, JSON.stringify(resp.error)).toBe(true);
    trackKey(ctx, resp.data.id);
    return resp.data.key;
  }

  const purgedEdgeFrame = (events: SseEvent[], edgeId: string) =>
    events.find(
      (e) =>
        e.event === "edge.deleted" &&
        (e.data as { edge?: { id?: string } }).edge?.id === edgeId,
    );
  const itemArrived = (events: SseEvent[], id: string): boolean =>
    events.some((e) => (e.data as { item?: { id?: string } }).item?.id === id);

  it("withholds a purged item's edges from a subscriber that could not read it, live and on a replay", async ({
    signal,
  }) => {
    const narrow = await notesOnlyKey("stream-purged-narrow");
    const { eventId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => makeItem("purged-marker"),
      signal,
    );

    let rows: { edgeId: string; sentinel: string } | undefined;
    await withStream(apiUrl, narrow, {}, async (narrowStream) => {
      await withStream(apiUrl, apiKey, {}, async (wideStream) => {
        await new Promise((r) => setTimeout(r, 300));
        rows = await purgeABookmarkWithAnEdge("live");
        const { edgeId, sentinel } = rows;

        const wide = await collectUntil(
          wideStream,
          (evts) => itemArrived(evts, sentinel),
          `the sentinel ${sentinel} on an unnarrowed stream`,
          signal,
        );
        // The witness: the purge announced the edge, naming its source.
        const frame = purgedEdgeFrame(wide.events, edgeId);
        expect(frame, "the purge never announced the edge").toBeDefined();
        expect((frame?.data as { source_type?: string }).source_type).toBe(
          "core.bookmark",
        );

        const seen = await collectUntil(
          narrowStream,
          (evts) => itemArrived(evts, sentinel),
          `the sentinel ${sentinel} on the narrowed stream`,
          signal,
        );
        expect(
          purgedEdgeFrame(seen.events, edgeId),
          "a subscriber that may not read bookmarks was told about a purged bookmark's edge",
        ).toBeUndefined();
      });
    });

    const { edgeId, sentinel } = rows!;
    for (const [key, shown] of [
      [apiKey, true],
      [narrow, false],
    ] as const) {
      await withStream(apiUrl, key, { lastEventId: eventId }, async (s) => {
        const { events } = await collectUntil(
          s,
          (evts) => itemArrived(evts, sentinel),
          `the sentinel ${sentinel} on a replay`,
          signal,
        );
        expect(purgedEdgeFrame(events, edgeId) !== undefined).toBe(shown);
      });
    }
  });
});
