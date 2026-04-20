import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

interface AuditRow {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  timestamp: string;
}

interface AuditPage {
  data: AuditRow[];
  cursor: string | null;
  has_more: boolean;
}

async function seedAudit(
  action: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await ctx.storage.audit.log({
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  });
}

describe("GET /audit", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/audit");
    expect(res.status).toBe(401);
  });

  it("returns the paginated shape { data, cursor, has_more }", async () => {
    await seedAudit("test.shape", "test", "shape-1");

    const res = await request(ctx.app, "GET", "/audit", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(Array.isArray(body.data)).toBe(true);
    // cursor is nullable per the route schema; has_more is a boolean.
    expect(typeof body.has_more).toBe("boolean");
    expect(body.cursor === null || typeof body.cursor === "string").toBe(true);
  });

  it("filters by action", async () => {
    await seedAudit("test.filter.action", "test", "f-1");
    await seedAudit("test.filter.action", "test", "f-2");
    await seedAudit("test.other", "test", "f-3");

    const res = await request(
      ctx.app,
      "GET",
      "/audit?action=test.filter.action",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const entry of body.data) {
      expect(entry.action).toBe("test.filter.action");
    }
  });

  it("filters by resource_type", async () => {
    await seedAudit("test.rt", "unique-resource-type-xyz", "rt-1");

    const res = await request(
      ctx.app,
      "GET",
      "/audit?resource_type=unique-resource-type-xyz",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) {
      expect(entry.resource_type).toBe("unique-resource-type-xyz");
    }
  });

  it("filters by resource_id", async () => {
    const uniqueId = `resource-id-${Math.random().toString(36).slice(2, 10)}`;
    await seedAudit("test.rid", "test", uniqueId);

    const res = await request(
      ctx.app,
      "GET",
      `/audit?resource_id=${uniqueId}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) {
      expect(entry.resource_id).toBe(uniqueId);
    }
  });

  it("filters by since/until time window", async () => {
    const before = new Date().toISOString();
    await seedAudit("test.window", "test", "w-1");
    // Tight window anchored to "before"; an `until` in the past should
    // exclude the entry we just wrote.
    const res = await request(
      ctx.app,
      "GET",
      `/audit?action=test.window&until=${encodeURIComponent(before)}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    for (const entry of body.data) {
      // None of the returned entries should exceed the `until` clamp.
      expect(entry.timestamp <= before).toBe(true);
    }

    // And a since-anchor in the past should include it.
    const sinceRes = await request(
      ctx.app,
      "GET",
      `/audit?action=test.window&since=${encodeURIComponent(before)}`,
      { key: ctx.adminKey },
    );
    expect(sinceRes.status).toBe(200);
    const sinceBody = (await sinceRes.json()) as AuditPage;
    expect(sinceBody.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects limit below 1 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=0", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects limit above 200 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=500", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("respects limit and paginates via cursor across two pages", async () => {
    // Seed enough entries under a unique action to split across 2 pages of 2.
    const action = `test.page.${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 5; i++) {
      await seedAudit(action, "test", `p-${String(i)}`);
    }

    const page1Res = await request(
      ctx.app,
      "GET",
      `/audit?action=${action}&limit=2`,
      { key: ctx.adminKey },
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as AuditPage;
    expect(page1.data.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.cursor).not.toBeNull();

    const cursor = page1.cursor;
    expect(cursor).toBeTruthy();

    const page2Res = await request(
      ctx.app,
      "GET",
      `/audit?action=${action}&limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      { key: ctx.adminKey },
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as AuditPage;
    expect(page2.data.length).toBe(2);

    // Pages must not overlap.
    const page1Ids = new Set(page1.data.map((e) => e.id));
    for (const entry of page2.data) {
      expect(page1Ids.has(entry.id)).toBe(false);
    }
  });
});
