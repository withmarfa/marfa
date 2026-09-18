import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, waitForAudit } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { parseTrustedProxyCidrs } from "../middleware/client-ip.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface AuditRow {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  timestamp: string;
  client_ip: string | null;
  details: Record<string, unknown>;
}

interface AuditPage {
  data: AuditRow[];
  cursor: string | null;
  has_more: boolean;
}

/**
 * An audit row in the context's space.
 *
 * Stamped rather than left space-less because `GET /audit` reads the caller's
 * own space, and every credential that reaches the route is bound to one. A
 * row with no space belongs to no reader and would be seeded into a corner of
 * the table nothing in this file can see.
 */
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
      key: ctx.spaceKey,
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
    );
    expect(sinceRes.status).toBe(200);
    const sinceBody = (await sinceRes.json()) as AuditPage;
    expect(sinceBody.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects limit below 1 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=0", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects limit above 200 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=500", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("captures the resolved client IP on rows produced by route handlers", async () => {
    // Issue an authenticated POST that emits an audit row, with a
    // synthetic peer IP. No TRUSTED_PROXY_CIDRS — peer is the only
    // trusted source. The audit row must carry that peer.
    const uniqueTitle = `t027-peer-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      peer: "203.0.113.42",
      body: { type: "core.task", properties: { title: uniqueTitle } },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { item: { id: string } };

    // Look up the audit row for the item we just created — most reliable
    // way to find our own row vs. unrelated noise from other tests.
    // Poll briefly because `audit.log` is fire-and-forget — the insert can
    // land after this GET would otherwise return.
    const body = await waitForAudit(
      async () => {
        const listRes = await request(
          ctx.app,
          "GET",
          `/audit?action=item.create&resource_id=${created.item.id}`,
          { key: ctx.spaceKey, peer: "203.0.113.42" },
        );
        expect(listRes.status).toBe(200);
        return (await listRes.json()) as AuditPage;
      },
      (b) => b.data.length >= 1,
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.client_ip).toBe("203.0.113.42");
    // client_ip is also folded into the details JSON — the persistence
    // channel — and lifted back to the typed field on read.
    expect(body.data[0]?.details.client_ip).toBe("203.0.113.42");
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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

  // NOTE: this test creates a SECOND TestContext with custom config.
  // Keep this test LAST in the describe block so fresh-context tests do
  // not run before any test that relies on the file-level fixture.
  it("honors TRUSTED_PROXY_CIDRS when stamping the audit IP", async () => {
    // Stand up a fresh app whose config trusts 10.0.0.0/8 as a proxy
    // CIDR. A request whose peer is in 10.0.0.0/8 and whose
    // x-forwarded-for ends in `203.0.113.7` should produce an audit
    // row with `client_ip: 203.0.113.7` (the leftmost untrusted hop).
    const trustedCtx = await createTestContext({
      trustedProxyCidrs: parseTrustedProxyCidrs("10.0.0.0/8"),
    });
    try {
      const uniqueTitle = `t027-proxy-${Math.random().toString(36).slice(2, 8)}`;
      const res = await request(trustedCtx.app, "POST", "/items", {
        key: trustedCtx.spaceKey,
        peer: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.7" },
        body: { type: "core.task", properties: { title: uniqueTitle } },
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { item: { id: string } };

      // Same fire-and-forget audit race — poll until the row lands.
      const body = await waitForAudit(
        async () => {
          const listRes = await request(
            trustedCtx.app,
            "GET",
            `/audit?action=item.create&resource_id=${created.item.id}`,
            {
              key: trustedCtx.spaceKey,
              peer: "10.0.0.5",
              headers: { "x-forwarded-for": "203.0.113.7" },
            },
          );
          expect(listRes.status).toBe(200);
          return (await listRes.json()) as AuditPage;
        },
        (b) => b.data.length >= 1,
      );
      expect(body.data).toHaveLength(1);
      // The leftmost untrusted hop is the recorded IP — NOT the peer
      // (which was a trusted proxy) and NOT some other XFF entry.
      expect(body.data[0]?.client_ip).toBe("203.0.113.7");
    } finally {
      await trustedCtx.cleanup();
    }
  });
});
