import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createTask } from "../../generators/items.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "webhook-delivery",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

/** A key the run's key mints with `webhooks.manage` and the reach given. */
async function keyWith(
  label: string,
  reach: Record<string, unknown>,
): Promise<{ id: string; client: MarfaClient }> {
  const minted = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    permissions: ["webhooks.manage"],
    ...reach,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return {
    id: minted.data.id,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
  };
}

async function registerEdgeType(label: string): Promise<string> {
  const id = `mock.webhook.${label}.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    id,
    cardinality: "many-to-many",
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  trackEdgeType(ctx, id);
  return id;
}

async function makeNote(label: string): Promise<string> {
  const note = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `hook-${label}` } }),
  );
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  trackItem(ctx, note.data.item.id);
  return note.data.item.id;
}

async function makeTask(label: string): Promise<string> {
  const task = await client.createItem(
    createTask({ source: ctx.source, properties: { title: `hook-${label}` } }),
  );
  expect(task.ok, JSON.stringify(task.error)).toBe(true);
  trackItem(ctx, task.data.item.id);
  return task.data.item.id;
}

async function link(
  source: string,
  target: string,
  edgeType: string,
): Promise<string> {
  const edge = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  return edge.data.edge.id;
}

async function purge(itemId: string): Promise<void> {
  expect((await client.deleteItem(itemId)).ok).toBe(true);
  const purged = await client.purgeItem(itemId);
  expect(purged.ok, JSON.stringify(purged.error)).toBe(true);
}

describe("outbound webhook delivery", () => {
  it("sends no edge.deleted for an edge a purge took to an owner who may not read the purged item's type, and sends it for a type the owner reads", async () => {
    const edgeType = await registerEdgeType("purged-source");
    const owner = await keyWith("purged-source-owner", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrow = await owner.client.createWebhook({
      url: receiver.hookUrl("purged-narrow"),
      events: ["edge.deleted"],
    });
    expect(narrow.status).toBe(201);
    trackWebhook(ctx, narrow.data.id, owner.client);
    // The witness that the purge announced the edge and it could be sent:
    // a subscription of the run's own key, which reads every type.
    const wide = await client.createWebhook({
      url: receiver.hookUrl("purged-wide"),
      events: ["edge.deleted"],
    });
    expect(wide.status).toBe(201);
    trackWebhook(ctx, wide.data.id, client);

    const target = await makeNote("purged-target");
    const task = await makeTask("purged-source");
    const taskEdge = await link(task, target, edgeType);
    await purge(task);

    // The sentinel: the same purge of a source the owner reads, written
    // after the first so its delivery says the first was already decided.
    const note = await makeNote("purged-readable-source");
    const noteEdge = await link(note, target, edgeType);
    await purge(note);

    const delivered = await receiver.waitFor(
      (r) => r.path === "/hook/purged-narrow" && r.body.includes(noteEdge),
    );
    expect(delivered.headers["x-marfa-event-type"]).toBe("edge.deleted");
    expect(JSON.parse(delivered.body)).toMatchObject({
      event_type: "edge.deleted",
      source_type: "core.note",
      purged_with: note,
    });
    await receiver.waitFor(
      (r) => r.path === "/hook/purged-wide" && r.body.includes(taskEdge),
    );
    await receiver.waitFor(
      (r) => r.path === "/hook/purged-wide" && r.body.includes(noteEdge),
    );

    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/purged-narrow" && r.body.includes(taskEdge),
      ),
      "an owner that may not read tasks was sent the edge of a purged task",
    ).toHaveLength(0);
    const rows = await owner.client.listWebhookDeliveries(narrow.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.data).toHaveLength(1);
  });
});
