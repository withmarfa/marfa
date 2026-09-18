import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "audit"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function createdRow(itemId: string) {
  const rows = await client.listAudit({
    resource_id: itemId,
    action: "item.create",
  });
  expect(rows.ok).toBe(true);
  expect(rows.data.data).toHaveLength(1);
  return rows.data.data[0];
}

describe("audit log", () => {
  it("records a write with the acting key, the resource and the action", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const rows = await client.listAudit({ resource_id: item.data.item.id });
    expect(rows.ok).toBe(true);
    await expectMatchesSchema("GET", "/audit", 200, rows.data);
    const row = rows.data.data.find((r) => r.action === "item.create");
    expect(row).toBeDefined();
    expect(row?.resource_type).toBe("item");
    expect(row?.resource_id).toBe(item.data.item.id);
    expect(row?.key_id).toBe(ctx.trackedKeys[0]);
    expect(row?.details.type).toBe("core.note");
  });

  it("filters by action and resource type with an excluded control", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const tagged = await client.addTags(item.data.item.id, ["audited"]);
    expect(tagged.ok).toBe(true);

    const creates = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
    });
    expect(creates.ok).toBe(true);
    expect(creates.data.data.map((r) => r.action)).toEqual(["item.create"]);

    const tags = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.tag",
    });
    expect(tags.ok).toBe(true);
    expect(tags.data.data.map((r) => r.action)).toEqual(["item.tag"]);

    const edges = await client.listAudit({
      resource_id: item.data.item.id,
      resource_type: "edge",
    });
    expect(edges.ok).toBe(true);
    expect(edges.data.data).toEqual([]);
  });

  it("bounds by since and until, both inclusive of the row's own instant", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const row = await createdRow(item.data.item.id);
    const at = Date.parse(row.timestamp);
    const before = new Date(at - 1).toISOString();
    const after = new Date(at + 1).toISOString();

    const untilExact = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
      until: row.timestamp,
    });
    expect(untilExact.ok).toBe(true);
    expect(untilExact.data.data.map((r) => r.id)).toEqual([row.id]);

    const untilBefore = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
      until: before,
    });
    expect(untilBefore.ok).toBe(true);
    expect(untilBefore.data.data).toEqual([]);

    const sinceExact = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
      since: row.timestamp,
    });
    expect(sinceExact.ok).toBe(true);
    expect(sinceExact.data.data.map((r) => r.id)).toEqual([row.id]);

    const sinceAfter = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
      since: after,
    });
    expect(sinceAfter.ok).toBe(true);
    expect(sinceAfter.data.data).toEqual([]);
  });

  it("paginates with a cursor and delivers every row once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const item = await client.createItem(createNote({ source: ctx.source }));
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      ids.push(item.data.item.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await client.listAudit({
        action: "item.create",
        limit: 2,
        cursor,
      });
      expect(rows.ok).toBe(true);
      expect(rows.data.data.length).toBeLessThanOrEqual(2);
      seen.push(...rows.data.data.map((r) => r.resource_id));
      if (!rows.data.has_more) break;
      expect(typeof rows.data.cursor).toBe("string");
      cursor = rows.data.cursor ?? undefined;
    }
    for (const id of ids) {
      expect(seen.filter((s) => s === id)).toHaveLength(1);
    }
  });

  it("refuses a key without space.audit_read", async () => {
    const keyResp = await client.createKey({
      label: "no-audit",
      source: `${ctx.source}-no-audit`,
      space_permissions: [],
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });
    const rows = await narrowed.listAudit();
    expect(rows.status).toBe(403);
    expect(rows.error?.error.code).toBe("forbidden");
  });

  it("refuses a request with no credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const rows = await anonymous.listAudit();
    expect(rows.status).toBe(401);
    expect(rows.error?.error.code).toBe("unauthorized");
  });
});
