import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  trackType,
  trackWebhook,
  cleanup,
  getManagementClient,
} from "../../utils/setup.js";
import { startReceiver } from "../../utils/webhook-receiver.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "audit-actions"));
  operator = getManagementClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

/** The actions the log holds for one resource, whoever wrote them. */
async function actionsOf(
  resourceId: string,
  resourceType?: string,
): Promise<string[]> {
  const actions: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAudit({
      resource_id: resourceId,
      ...(resourceType === undefined ? {} : { resource_type: resourceType }),
      limit: 200,
      cursor,
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    actions.push(...page.data.data.map((entry) => entry.action));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return actions;
}

/** The actions that name no resource, such as a page or a request over several. */
async function expectSince(action: string, since: string): Promise<void> {
  const page = await client.listAudit({
    action,
    created_after: since,
    limit: 200,
  });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  expect(page.data.data.length, action).toBeGreaterThan(0);
}

/** Each of `expected` is among what the log holds for the resource. */
async function expectActions(
  what: string,
  resourceId: string,
  expected: string[],
  resourceType?: string,
): Promise<void> {
  const held = await actionsOf(resourceId, resourceType);
  for (const action of expected)
    expect(held, `${what}: ${action}`).toContain(action);
}

describe("the names of the audit log's actions", () => {
  it("names each write of an item with the action the table gives it", async () => {
    const created = await client.createItem(
      createNote({ source: ctx.source, tags: ["audit-actions"] }),
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);

    const updated = await client.updateItem(id, {
      version: created.data.item.version,
      properties: { title: "Renamed" },
    });
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    expect((await client.addTags(id, ["added"])).ok).toBe(true);
    expect((await client.removeTag(id, "added")).ok).toBe(true);
    expect((await client.replaceMetadata(id, { tags: ["only"] })).ok).toBe(
      true,
    );
    const namespace = `audit_actions_${ctx.runId.replace(/[^a-z0-9]/gi, "_")}`;
    expect((await client.setItemExtension(id, namespace, { a: 1 })).ok).toBe(
      true,
    );
    expect((await client.deleteItemExtension(id, namespace)).ok).toBe(true);
    expect((await client.deleteItem(id)).ok).toBe(true);
    expect((await client.restoreItem(id)).ok).toBe(true);
    const trashing = new Date(Date.now() - 1000).toISOString();
    expect((await client.trashItems([id])).ok).toBe(true);
    expect((await client.purgeItem(id)).ok).toBe(true);
    await expectSince("items.trash", trashing);

    await expectActions("an item", id, [
      "item.create",
      "item.update",
      "item.tag",
      "item.untag",
      "item.metadata.replace",
      "extension.set",
      "extension.delete",
      "item.delete",
      "item.restore",
      "item.purge",
    ]);
  });

  it("names a transition and a bulk write with the action the table gives it", async () => {
    const created = await client.createItem(createNote({ source: ctx.source }));
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    const moved = await client.transitionItem(id, "archived");
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    await expectActions("a transition", id, ["item.transition"]);

    const bulk = await client.bulkItems({
      atomic: false,
      items: [createNote({ source: ctx.source })],
    });
    expect(bulk.ok, JSON.stringify(bulk.error)).toBe(true);
    const bulked = bulk.data.results[0]!.id!;
    trackItem(ctx, bulked);
    await expectActions("a bulk item", bulked, ["items.bulk"]);
  });

  it("names each write of an edge and of an edge type with the action the table gives it", async () => {
    const edgeType = `mock.audit-actions.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      label: "Audit actions",
      cardinality: "many-to-many",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, edgeType);
    const items = [];
    for (let at = 0; at < 3; at += 1) {
      const made = await client.createItem(createNote({ source: ctx.source }));
      expect(made.ok).toBe(true);
      trackItem(ctx, made.data.item.id);
      items.push(made.data.item.id);
    }
    const edge = await client.createEdge({
      source_id: items[0]!,
      target_id: items[1]!,
      edge_type: edgeType,
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    const changed = await client.updateEdge(edge.data.edge.id, {
      version: edge.data.edge.version,
      properties: {},
    });
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    const bulking = new Date(Date.now() - 1000).toISOString();
    const bulk = await client.bulkEdges({
      edges: [
        { source_id: items[1]!, target_id: items[2]!, edge_type: edgeType },
      ],
    });
    expect(bulk.ok, JSON.stringify(bulk.error)).toBe(true);
    const bulked = bulk.data.results[0]!.id!;
    trackEdge(ctx, bulked);
    expect((await client.deleteEdge(edge.data.edge.id)).ok).toBe(true);
    expect((await client.deleteEdge(bulked)).ok).toBe(true);

    await expectActions("an edge", edge.data.edge.id, [
      "edge.create",
      "edge.update",
      "edge.delete",
    ]);
    await expectSince("edges.bulk", bulking);
    await expectActions("a bulk edge", bulked, ["edge.delete"]);

    expect((await client.deleteEdgeType(edgeType)).ok).toBe(true);
    await expectActions(
      "an edge type",
      edgeType,
      ["edge_type.register", "edge_type.delete"],
      "edge_type",
    );
  });

  it("names each write of a type with the action the table gives it", async () => {
    const id = `user.audit-actions-${ctx.runId}`;
    const fields = { heading: { type: "string" as const } };
    const registered = await client.registerType({ id, fields });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackType(ctx, id, client);
    const replaced = await client.replaceType(id, {
      id,
      fields: { ...fields, text: { type: "string" } },
    });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
    const settled = await client.settleTombstones({
      type: id,
      source: ctx.source,
      source_ids: ["audit-actions"],
      settled_at: new Date().toISOString(),
    });
    expect(settled.ok, JSON.stringify(settled.error)).toBe(true);
    expect((await client.deleteType(id)).ok).toBe(true);
    await expectActions(
      "a type",
      id,
      ["type.register", "type.replace", "items.tombstones", "type.delete"],
      "type",
    );
  });

  it("names the writes of a key and of a webhook with the action the table gives it", async () => {
    const minted = await client.createKey({
      label: "audit-actions",
      source: `${ctx.source}-key`,
      type_permissions: { "core.note": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const renamed = await client.updateKey(minted.data.id, {
      label: "audit-actions-renamed",
    });
    expect(renamed.ok, JSON.stringify(renamed.error)).toBe(true);
    expect((await client.revokeKey(minted.data.id)).ok).toBe(true);
    await expectActions("a key", minted.data.id, [
      "key.create",
      "key.update",
      "key.revoke",
    ]);

    const receiver = await startReceiver();
    try {
      const hook = await client.createWebhook({
        url: receiver.hookUrl("audit-actions"),
        events: ["item.created"],
      });
      expect(hook.status, JSON.stringify(hook.error)).toBe(201);
      trackWebhook(ctx, hook.data.id, client);
      const changed = await client.updateWebhook(hook.data.id, {
        active: false,
      });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      expect((await client.deleteWebhook(hook.data.id)).ok).toBe(true);
      await expectActions("a webhook", hook.data.id, [
        "webhook.create",
        "webhook.update",
        "webhook.delete",
      ]);
    } finally {
      await receiver.close();
    }
  });

  it("names the writes of a connector and of an upload with the action the table gives it", async () => {
    const registered = await operator.registerConnector({
      name: `audit-actions-${ctx.runId}`,
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const id = registered.data.id;
    const endpoint = await operator.createInboundEndpoint(id);
    expect(endpoint.status, JSON.stringify(endpoint.error)).toBe(201);
    expect(
      (await operator.retireInboundEndpoint(id, endpoint.data.id)).ok,
    ).toBe(true);
    expect((await operator.deleteConnectorState(id)).ok).toBe(true);
    expect((await operator.deleteConnector(id)).ok).toBe(true);
    await expectActions("a connector", id, [
      "connector.register",
      "connector_state.delete",
      "connector.delete",
    ]);
    await expectActions("an endpoint", endpoint.data.id, [
      "inbound_endpoint.create",
      "inbound_endpoint.retire",
    ]);

    const upload = await client.uploadBlob(
      new TextEncoder().encode(`audit-actions upload ${ctx.runId}`),
      "text/plain",
    );
    expect(upload.ok, JSON.stringify(upload.error)).toBe(true);
    await expectActions("an upload", upload.data.hash, ["blob.upload"]);
  });

  it("names an export with the action the table gives it", async () => {
    const runs = async (): Promise<Set<string>> => {
      const ids = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listAudit({
          action: "export.run",
          limit: 200,
          cursor,
        });
        expect(page.ok, JSON.stringify(page.error)).toBe(true);
        for (const entry of page.data.data) ids.add(entry.id);
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return ids;
    };
    const before = await runs();
    const exported = await client.exportItems({ source: ctx.source });
    expect(exported.ok, JSON.stringify(exported.error)).toBe(true);
    const added = [...(await runs())].filter((id) => !before.has(id));
    expect(added.length).toBe(1);
  });
});
