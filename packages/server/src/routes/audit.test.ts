import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
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
  created_at: string;
  client_ip: string | null;
  details: Record<string, unknown>;
}

interface AuditPage {
  data: AuditRow[];
  next_cursor: string | null;
}

/** An audit row for this context to read back. */
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

/** The completed `test.window` audit rows, oldest first. */
async function windowRows(count: number): Promise<AuditRow[]> {
  const res = await request(ctx.app, "GET", "/audit?action=test.window", {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as AuditPage;
  expect(body.data).toHaveLength(count);
  return body.data.slice().reverse();
}

describe("GET /audit", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/audit");
    expect(res.status).toBe(401);
  });

  it("returns the paginated shape { data, next_cursor }", async () => {
    await seedAudit("test.shape", "test", "shape-1");

    const res = await request(ctx.app, "GET", "/audit", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(Array.isArray(body.data)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["data", "next_cursor"]);
    expect(
      body.next_cursor === null || typeof body.next_cursor === "string",
    ).toBe(true);
  });

  it("filters by action", async () => {
    await seedAudit("test.filter.action", "test", "f-1");
    await seedAudit("test.filter.action", "test", "f-2");
    await seedAudit("test.other", "test", "f-3");

    const res = await request(
      ctx.app,
      "GET",
      "/audit?action=test.filter.action",
      { key: ctx.workingKey },
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
      { key: ctx.workingKey },
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
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPage;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) {
      expect(entry.resource_id).toBe(uniqueId);
    }
  });

  it("bounds by created_after and created_before, both exclusive", async () => {
    // Three rows, because fewer cannot tell the failures apart. The row on
    // the bound's instant proves the comparison is strict rather than
    // inclusive; the row inside the range proves the predicate reached the
    // query at all, because a dropped bound and a bound that matched
    // nothing both leave the boundary row absent; the far row proves the
    // bound narrows in the direction it claims.
    for (let i = 0; i < 3; i++) {
      await seedAudit("test.window", "test", `w-${String(i)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await windowRows(3);
    const [earlier, onBound, later] = rows as [AuditRow, AuditRow, AuditRow];
    expect(
      new Set(rows.map((r) => r.created_at)).size,
      "two rows share an instant, so a bound on one cannot separate them",
    ).toBe(3);

    const ids = async (query: string): Promise<string[]> => {
      const res = await request(
        ctx.app,
        "GET",
        `/audit?action=test.window&limit=200&${query}`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as AuditPage;
      // The page has to be whole, or an absence below is a truncation
      // rather than a bound.
      expect(
        body.next_cursor,
        "the page was truncated, so a row missing from it proves nothing",
      ).toBeNull();
      return body.data.map((e) => e.id);
    };

    const afterBound = await ids(
      `created_after=${encodeURIComponent(onBound.created_at)}`,
    );
    expect(afterBound).not.toContain(onBound.id);
    expect(afterBound).toContain(later.id);
    expect(afterBound).not.toContain(earlier.id);

    const beforeBound = await ids(
      `created_before=${encodeURIComponent(onBound.created_at)}`,
    );
    expect(beforeBound).not.toContain(onBound.id);
    expect(beforeBound).toContain(earlier.id);
    expect(beforeBound).not.toContain(later.id);
  });

  it("rejects limit below 1 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=0", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects limit above 200 with 400", async () => {
    const res = await request(ctx.app, "GET", "/audit?limit=500", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("captures the resolved client IP on rows produced by route handlers", async () => {
    // Issue an authenticated POST that emits an audit row, with a
    // synthetic peer IP. No TRUSTED_PROXY_CIDRS — peer is the only
    // trusted source. The audit row must carry that peer.
    const uniqueTitle = `audit-peer-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      peer: "203.0.113.42",
      body: { type: "core.task", properties: { title: uniqueTitle } },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { item: { id: string } };

    // Look up the audit row for the item we just created — most reliable
    // way to find our own row vs. unrelated noise from other tests.
    const body = await (async () => {
      const listRes = await request(
        ctx.app,
        "GET",
        `/audit?action=item.create&resource_id=${created.item.id}`,
        { key: ctx.workingKey, peer: "203.0.113.42" },
      );
      expect(listRes.status).toBe(200);
      return (await listRes.json()) as AuditPage;
    })();
    expect(body.data.length >= 1).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.client_ip).toBe("203.0.113.42");
    // Its own field, not a key smuggled through `details`: the details
    // are the writer's alone.
    expect(body.data[0]?.details).not.toHaveProperty("client_ip");
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
      { key: ctx.workingKey },
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as AuditPage;
    expect(page1.data.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();
    expect(page1.next_cursor).not.toBeNull();

    const cursor = page1.next_cursor;
    expect(cursor).toBeTruthy();

    const page2Res = await request(
      ctx.app,
      "GET",
      `/audit?action=${action}&limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      { key: ctx.workingKey },
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
      const uniqueTitle = `audit-proxy-${Math.random().toString(36).slice(2, 8)}`;
      const res = await request(trustedCtx.app, "POST", "/items", {
        key: trustedCtx.workingKey,
        peer: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.7" },
        body: { type: "core.task", properties: { title: uniqueTitle } },
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { item: { id: string } };

      // The completed request already has its audit record.
      const body = await (async () => {
        const listRes = await request(
          trustedCtx.app,
          "GET",
          `/audit?action=item.create&resource_id=${created.item.id}`,
          {
            key: trustedCtx.workingKey,
            peer: "10.0.0.5",
            headers: { "x-forwarded-for": "203.0.113.7" },
          },
        );
        expect(listRes.status).toBe(200);
        return (await listRes.json()) as AuditPage;
      })();
      expect(body.data.length >= 1).toBe(true);
      expect(body.data).toHaveLength(1);
      // The leftmost untrusted hop is the recorded IP — NOT the peer
      // (which was a trusted proxy) and NOT some other XFF entry.
      expect(body.data[0]?.client_ip).toBe("203.0.113.7");
    } finally {
      await trustedCtx.cleanup();
    }
  });
});
