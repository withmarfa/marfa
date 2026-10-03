import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

async function refuseAudit(action: string) {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
  };
  await raw.__sqliteRun(
    `CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`,
    [],
  );
}

describe("domain writes and their audit records", () => {
  it("refuses webhook creation when its audit insert fails", async () => {
    const send = (suffix: string) =>
      request(ctx.app, "POST", "/webhooks", {
        key: ctx.workingKey,
        body: {
          url: `https://receiver.example/${suffix}`,
          events: ["item.created"],
        },
      });
    const control = await send("control");
    expect(control.status).toBe(201);
    const hook = (await control.json()) as { id: string };
    await ctx.storage.audit.drain();
    expect(
      (await ctx.storage.audit.list({ resource_id: hook.id })).data,
    ).toHaveLength(1);
    await refuseAudit("webhook.create");
    expect((await send("fault")).status).toBe(500);
    expect(
      (await ctx.storage.outboundWebhooks.list()).map((row) => row.id),
    ).toEqual([hook.id]);
    expect(
      (await ctx.storage.audit.list({ action: "webhook.create" })).data,
    ).toHaveLength(1);
  });
});

import { generateId, listTypes, listEdgeTypes } from "@withmarfa/shared";
import {
  collectItemEvents,
  collectEdgeEvents,
  mintWorkingKey,
  settle,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import type { Item } from "@withmarfa/shared";

interface Door {
  method: string;
  path: string;
  body?: unknown;
  key?: string;
}
async function send(door: Door) {
  return request(ctx.app, door.method, door.path, {
    key: door.key ?? ctx.workingKey,
    body: door.body,
  });
}
async function item() {
  const res = await send({
    method: "POST",
    path: "/items",
    body: { type: "core.note", properties: { body: "before" } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}
async function folder() {
  const res = await send({
    method: "POST",
    path: "/folders",
    body: { title: "Before" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}
async function connector() {
  const key = await mintWorkingKey(ctx);
  const res = await send({
    method: "POST",
    path: "/connectors",
    key,
    body: { name: "Before" },
  });
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { id: string }).id, key };
}
async function edge() {
  const a = await item(),
    b = await item();
  const res = await send({
    method: "POST",
    path: "/edges",
    body: { source_id: a.id, target_id: b.id, edge_type: "about" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string; version: number } }).edge;
}
async function hook() {
  const res = await send({
    method: "POST",
    path: "/webhooks",
    body: { url: "https://receiver.example/hook", events: ["item.created"] },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function registeredType() {
  const id = `test.audit_${generateId().replaceAll("-", "")}`;
  const res = await send({
    method: "POST",
    path: "/types",
    body: { id, version: 1, fields: {} },
  });
  expect(res.status).toBe(201);
  return id;
}
const doors: [string, () => Door | Promise<Door>][] = [
  [
    "item.create",
    () => ({
      method: "POST",
      path: "/items",
      body: {
        id: generateId(),
        type: "core.note",
        properties: { body: "created" },
      },
    }),
  ],
  [
    "item.update",
    async () => {
      const row = await item();
      return {
        method: "PATCH",
        path: `/items/${row.id}`,
        body: { version: row.version, properties: { body: "after" } },
      };
    },
  ],
  [
    "item.delete",
    async () => ({ method: "DELETE", path: `/items/${(await item()).id}` }),
  ],
  [
    "item.purge",
    async () => {
      const row = await item();
      expect(
        (await send({ method: "DELETE", path: `/items/${row.id}` })).status,
      ).toBe(200);
      return { method: "DELETE", path: `/items/${row.id}/purge` };
    },
  ],
  [
    "item.restore",
    async () => {
      const row = await item();
      expect(
        (await send({ method: "DELETE", path: `/items/${row.id}` })).status,
      ).toBe(200);
      return { method: "POST", path: `/items/${row.id}/restore` };
    },
  ],
  [
    "item.transition",
    async () => ({
      method: "POST",
      path: `/items/${(await item()).id}/transition`,
      body: { state: "archived" },
    }),
  ],
  [
    "item.metadata.set",
    async () => ({
      method: "PUT",
      path: `/items/${(await item()).id}/metadata`,
      body: { tags: ["changed"] },
    }),
  ],
  [
    "item.metadata.merge",
    async () => ({
      method: "PATCH",
      path: `/items/${(await item()).id}/metadata`,
      body: { tags: ["changed"] },
    }),
  ],
  [
    "item.tag",
    async () => ({
      method: "POST",
      path: `/items/${(await item()).id}/tags`,
      body: { tags: ["changed"] },
    }),
  ],
  [
    "item.untag",
    async () => {
      const row = await item();
      await send({
        method: "POST",
        path: `/items/${row.id}/tags`,
        body: { tags: ["changed"] },
      });
      return { method: "DELETE", path: `/items/${row.id}/tags/changed` };
    },
  ],
  [
    "extension.set",
    async () => ({
      method: "PUT",
      path: `/items/${(await item()).id}/extensions/test`,
      body: { changed: true },
    }),
  ],
  [
    "extension.delete",
    async () => {
      const row = await item();
      await send({
        method: "PUT",
        path: `/items/${row.id}/extensions/test`,
        body: { changed: true },
      });
      return { method: "DELETE", path: `/items/${row.id}/extensions/test` };
    },
  ],
  [
    "folder.create",
    () => ({
      method: "POST",
      path: "/folders",
      body: { title: "Created" },
    }),
  ],
  [
    "folder.update",
    async () => {
      const row = await folder();
      return {
        method: "PATCH",
        path: `/folders/${row.id}`,
        body: { version: row.version, title: "Changed" },
      };
    },
  ],
  [
    "folder.revoke",
    async () => ({
      method: "POST",
      path: `/folders/${(await folder()).id}/revoke`,
    }),
  ],
  [
    "edge.create",
    async () => ({
      method: "POST",
      path: "/edges",
      body: {
        source_id: (await item()).id,
        target_id: (await item()).id,
        edge_type: "about",
      },
    }),
  ],
  [
    "edge.update",
    async () => {
      const row = await edge();
      return {
        method: "PATCH",
        path: `/edges/${row.id}`,
        body: { version: row.version, properties: { weight: 2 } },
      };
    },
  ],
  [
    "edge.delete",
    async () => ({ method: "DELETE", path: `/edges/${(await edge()).id}` }),
  ],
  [
    "type.register",
    () => ({
      method: "POST",
      path: "/types",
      body: {
        id: `test.audit_${generateId().replaceAll("-", "")}`,
        version: 1,
        fields: {},
      },
    }),
  ],
  [
    "type.update",
    async () => ({
      method: "PUT",
      path: `/types/${await registeredType()}`,
      body: { version: 2, label: "After", fields: {} },
    }),
  ],
  [
    "type.delete",
    async () => ({
      method: "DELETE",
      path: `/types/${await registeredType()}`,
    }),
  ],
  [
    "edge_type.create",
    () => ({
      method: "POST",
      path: "/edge-types",
      body: {
        id: `test.audit_${generateId().replaceAll("-", "")}`,
        cardinality: "many-to-many",
      },
    }),
  ],
  [
    "edge_type.delete",
    async () => {
      const id = `test.audit_${generateId().replaceAll("-", "")}`;
      expect(
        (
          await send({
            method: "POST",
            path: "/edge-types",
            body: { id, cardinality: "many-to-many" },
          })
        ).status,
      ).toBe(201);
      return { method: "DELETE", path: `/edge-types/${id}` };
    },
  ],
  [
    "config.update",
    () => ({
      method: "PUT",
      path: "/config",
      key: ctx.workingKey,
      body: { audit_retention_days: 42 },
    }),
  ],
  [
    "connector.register",
    async () => ({
      method: "POST",
      path: "/connectors",
      key: await mintWorkingKey(ctx),
      body: { name: "Created" },
    }),
  ],
  [
    "connector.delete",
    async () => {
      const row = await connector();
      return { method: "DELETE", path: `/connectors/${row.id}`, key: row.key };
    },
  ],
  [
    "inbound_endpoint.create",
    async () => {
      const row = await connector();
      return {
        method: "POST",
        path: `/connectors/${row.id}/endpoints`,
        key: row.key,
        body: { label: "Created" },
      };
    },
  ],
  [
    "inbound_endpoint.retire",
    async () => {
      const row = await connector();
      const res = await send({
        method: "POST",
        path: `/connectors/${row.id}/endpoints`,
        key: row.key,
        body: { label: "Retire" },
      });
      expect(res.status).toBe(201);
      const endpoint = (await res.json()) as { id: string };
      return {
        method: "DELETE",
        path: `/connectors/${row.id}/endpoints/${endpoint.id}`,
        key: row.key,
      };
    },
  ],
  [
    "connector_state.clear",
    async () => {
      const row = await connector();
      expect(
        (
          await send({
            method: "POST",
            path: `/connectors/${row.id}/hold`,
            key: row.key,
            body: { process: "audit-proof" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send({
            method: "PUT",
            path: `/connectors/${row.id}/state`,
            key: row.key,
            body: { process: "audit-proof", state: { cursor: "retained" } },
          })
        ).status,
      ).toBe(200);
      return {
        method: "DELETE",
        path: `/connectors/${row.id}/state`,
        key: row.key,
      };
    },
  ],
  [
    "items.tombstones",
    async () => {
      const sourceId = generateId();
      const created = await send({
        method: "POST",
        path: "/items",
        body: {
          type: "core.note",
          source_id: sourceId,
          properties: { body: "tombstone" },
        },
      });
      expect(created.status).toBe(201);
      const row = ((await created.json()) as { item: Item }).item;
      expect(
        (await send({ method: "DELETE", path: `/items/${row.id}` })).status,
      ).toBe(200);
      expect(
        (await send({ method: "DELETE", path: `/items/${row.id}/purge` }))
          .status,
      ).toBe(200);
      return {
        method: "POST",
        path: "/items/tombstones",
        body: {
          type: row.type,
          source: row.source,
          source_ids: [sourceId],
          settled_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
  ],
  [
    "webhook.update",
    async () => ({
      method: "PATCH",
      path: `/webhooks/${await hook()}`,
      body: { url: "https://receiver.example/after" },
    }),
  ],
  [
    "webhook.delete",
    async () => ({ method: "DELETE", path: `/webhooks/${await hook()}` }),
  ],
];

async function domainSnapshot() {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteAll(sql: string): Promise<unknown[]>;
  };
  const tables = [
    "items",
    "metadata",
    "versions",
    "edges",
    "types",
    "edge_types",
    "settings",
    "connectors",
    "connector_states",
    "connector_agreements",
    "link_tombstones",
    "natural_key_tombstones",
    "inbound_endpoints",
    "outbound_webhooks",
    "outbound_webhook_deliveries",
    "event_log",
    "audit_log",
  ];
  const rows: Record<string, unknown[]> = {};
  for (const table of tables)
    rows[table] = await raw.__sqliteAll(
      `SELECT * FROM ${table} ORDER BY rowid`,
    );
  return { rows, types: listTypes(), edgeTypes: listEdgeTypes() };
}

describe.each(doors)("%s transaction", (action, prepare) => {
  it("records success immediately and rolls SQL, registry and events back on audit failure", async () => {
    initEventLog(ctx.storage.eventLog);
    const abort = new AbortController();
    const live = collectItemEvents(abort.signal),
      edges = collectEdgeEvents(abort.signal);
    try {
      const first = await prepare();
      const beforeSuccess = await domainSnapshot();
      const res = await send(first);
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      expect(
        (await ctx.storage.audit.list({ action })).data.length,
      ).toBeGreaterThan(0);
      const afterSuccess = await domainSnapshot();
      // An audit-only implementation must not satisfy the positive control.
      for (const snapshot of [beforeSuccess, afterSuccess]) {
        delete snapshot.rows.audit_log;
        delete snapshot.rows.event_log;
      }
      expect(afterSuccess).not.toEqual(beforeSuccess);
      const second = await prepare();
      await ctx.storage.audit.drain();
      await settle();
      const before = await domainSnapshot(),
        itemEvents = live.events.length,
        edgeEvents = edges.events.length;
      await refuseAudit(action);
      const failed = await send(second);
      expect(failed.status, await failed.clone().text()).toBe(500);
      await settle();
      expect(await domainSnapshot()).toEqual(before);
      expect(live.events).toHaveLength(itemEvents);
      expect(edges.events).toHaveLength(edgeEvents);
    } finally {
      abort.abort();
      await Promise.all([live.done, edges.done]);
      __resetEventLogForTests();
    }
  });
});

import { WebhookPoller, WebhookScheduler } from "../webhooks/delivery.js";
it("audits one accepted redelivery, refuses foreign and duplicate calls, and rolls failed audit back", async () => {
  initEventLog(ctx.storage.eventLog);
  try {
    const id = await hook();
    await item();
    await new WebhookScheduler({
      storage: ctx.storage,
      wakePoller: () => Promise.resolve(),
    }).runOnce();
    await new WebhookPoller({
      storage: ctx.storage,
      http: {
        post: () =>
          Promise.resolve({ kind: "answered", status: 400, retryAfter: null }),
      },
    }).runOnce();
    const delivery = (
      await ctx.storage.outboundWebhookDeliveries.list(id, { limit: 10 })
    ).data[0]!;
    expect(delivery.status).toBe("dead_letter");
    const path = `/webhooks/${id}/deliveries/${delivery.id}/redeliver`;
    expect(
      (await send({ method: "POST", path, key: await mintWorkingKey(ctx) }))
        .status,
    ).toBe(404);
    await refuseAudit("webhook.delivery.redeliver");
    expect((await send({ method: "POST", path })).status).toBe(500);
    expect(
      await ctx.storage.outboundWebhookDeliveries.get(id, delivery.id),
    ).toEqual(delivery);
    await (
      ctx.storage as typeof ctx.storage & {
        __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
      }
    ).__sqliteRun("DROP TRIGGER reject_audit", []);
    const results = await Promise.all([
      send({ method: "POST", path }),
      send({ method: "POST", path }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    const audit = (
      await ctx.storage.audit.list({
        action: "webhook.delivery.redeliver",
        resource_id: delivery.id,
      })
    ).data;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toEqual({ webhook_id: id });
    expect(audit[0]?.key_id).toBeTruthy();
    expect(
      (await ctx.storage.outboundWebhookDeliveries.get(id, delivery.id))
        ?.status,
    ).toBe("pending");
  } finally {
    __resetEventLogForTests();
  }
});

it("acknowledges repeated item and edge creates without a second audit", async () => {
  const row = {
    id: generateId(),
    type: "core.note",
    properties: { body: "same" },
  };
  const create = () => send({ method: "POST", path: "/items", body: row });
  expect((await create()).status).toBe(201);
  expect((await create()).status).toBe(200);
  expect(
    (
      await ctx.storage.audit.list({
        action: "item.create",
        resource_id: row.id,
      })
    ).data,
  ).toHaveLength(1);
  const target = await item();
  const edgeRow = {
    id: generateId(),
    source_id: row.id,
    target_id: target.id,
    edge_type: "about",
  };
  const createEdge = () =>
    send({ method: "POST", path: "/edges", body: edgeRow });
  expect((await createEdge()).status).toBe(201);
  expect((await createEdge()).status).toBe(200);
  expect(
    (
      await ctx.storage.audit.list({
        action: "edge.create",
        resource_id: edgeRow.id,
      })
    ).data,
  ).toHaveLength(1);
});
