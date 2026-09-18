import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { openEventStream, type SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
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
      r.headers["x-marfa-event"] === name &&
      r.body.includes(edgeId);
    const created = await receiver.waitFor(forOurEdge("edge.created"));
    const deleted = await receiver.waitFor(forOurEdge("edge.deleted"));
    for (const delivery of [created, deleted]) {
      expectSignedBy(delivery, subscription.data.secret);
    }
    const payload = JSON.parse(created.body) as {
      event: string;
      edge: { id: string; edge_type: string };
    };
    expect(payload.event).toBe("edge.created");
    expect(payload.edge.id).toBe(edgeId);
    expect(payload.edge.edge_type).toBe("about");

    const rows = await client.listWebhookDeliveries(subscription.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.deliveries.map((d) => d.event).sort()).toEqual([
      "edge.created",
      "edge.deleted",
    ]);
    expect(rows.data.deliveries.every((d) => d.succeeded)).toBe(true);
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
});
