/**
 * An edge edit reaches another subscriber.
 *
 * The platform had `edge.created` and `edge.deleted` and nothing between
 * them, so `PATCH /edges/:id` changed an edge and told nobody. The SDK
 * exposes that route and carries an `updateEdge` mutation kind, so a client
 * could make the change and no second device ever heard about it.
 *
 * **Asserted through a live subscriber rather than through the enum.** The
 * union, the wire name, the webhook list and the emitter routing are four
 * places that each have to agree, and a test that reads any one of them
 * passes while the others are wrong. `subscribeEdges` is the thing a second
 * device actually is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { wireEventName } from "../pubsub.js";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface SeededEdge {
  id: string;
  source_id: string;
  target_id: string;
}

/** Two items and an edge between them. */
async function seedEdge(): Promise<SeededEdge> {
  const ids: string[] = [];
  for (const title of ["source", "target"]) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: title } },
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { item: { id: string } }).item.id);
  }
  const edge = await request(ctx.app, "POST", "/edges", {
    key: ctx.adminKey,
    body: {
      source_id: ids[0],
      target_id: ids[1],
      edge_type: "about",
      properties: { note: "before" },
    },
  });
  if (edge.status !== 201) {
    throw new Error(
      `seed edge failed: ${String(edge.status)} ${await edge.text()}`,
    );
  }
  return {
    id: ((await edge.json()) as { edge: { id: string } }).edge.id,
    source_id: ids[0]!,
    target_id: ids[1]!,
  };
}

describe("edge.updated", () => {
  it("is observed by a second subscriber when an edge is edited", async () => {
    const { id: edgeId } = await seedEdge();
    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const res = await request(ctx.app, "PATCH", `/edges/${edgeId}`, {
      key: ctx.adminKey,
      body: { properties: { note: "after" } },
    });
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const updates = events.filter((e) => e.type === "edge_updated");
    expect(updates).toHaveLength(1);
    // The edited payload rides the event, not just the id — a subscriber
    // that had to re-fetch would defeat the point of emitting one.
    expect(updates[0]?.edge.id).toBe(edgeId);
    expect(updates[0]?.edge.properties.note).toBe("after");
  });

  it("goes on the wire as `edge.updated`", () => {
    // The name a webhook and an SSE consumer see. Separate from the
    // subscriber assertion because the emitter and the wire name are two
    // different places to get it wrong.
    expect(wireEventName("edge_updated")).toBe("edge.updated");
  });

  it("is a subscribable webhook event", async () => {
    // The subscription allow-list is a third place. A webhook naming an
    // event the enum rejects is refused at create, so this is the whole
    // assertion.
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.adminKey,
      body: {
        url: "https://example.test/hook",
        events: ["edge.updated"],
      },
    });
    expect(res.status).toBe(201);
  });

  it("emits for a bulk upsert that edits an existing edge", async () => {
    // The second silence the ticket names. A subscriber cannot tell a bulk
    // edit from a single one, so emitting for one route and not the other
    // makes propagation depend on which the writer happened to use.
    const edge = await seedEdge();
    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        mode: "upsert",
        enable_fanout: true,
        edges: [
          {
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: "about",
            properties: { note: "bulk-edited" },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const updates = events.filter((e) => e.type === "edge_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.edge.properties.note).toBe("bulk-edited");
  });
});
