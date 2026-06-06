import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// system.activity: the server stamps `tier: "feed"` on activity items
// emitted by a connection whose `feed_activity === true`. Client tier
// writes on system.* remain rejected — only the server makes this
// decision, keyed off the per-Connection toggle.

interface ItemResponse {
  item: {
    id: string;
    type: string;
    tier?: "library" | "feed";
    properties: Record<string, unknown>;
  };
  metadata: { item_id: string; tags: string[]; extensions: object };
}

interface ListResponse {
  data: ItemResponse["item"][];
}

interface ErrorResponse {
  error: { code: string; message?: string };
}

async function createConnection(
  feedActivity: boolean,
  source: string,
): Promise<string> {
  // Stamping `source` makes the dedup index forgive repeated runs that
  // happen to share a tenant; pass-through unknown property `feed_activity`
  // is preserved by the loose-object validation.
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      source,
      properties: {
        kind: "integration",
        status: "active",
        granted_at: "2026-04-30T00:00:00.000Z",
        feed_activity: feedActivity,
      },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

describe("system.activity — schema + feed-tier exception", () => {
  it("creates an activity referencing a connection with feed_activity=true and stamps tier:'feed'", async () => {
    const connectionId = await createConnection(true, "conn-feed-true");
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "info",
          summary: "Synced 12 events from Work Calendar",
        },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.type).toBe("system.activity");
    expect(created.item.tier).toBe("feed");

    const getRes = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as ItemResponse;
    expect(fetched.item.tier).toBe("feed");
  });

  // For unstamped cases the storage default `tier: "library"` applies —
  // the same fallback every other system.* type takes today. The
  // important assertion is that tier is NOT "feed" — the hook does not
  // accidentally stamp it when feed_activity is absent or false.
  it("does not stamp tier:'feed' when the referenced connection has feed_activity=false", async () => {
    const connectionId = await createConnection(false, "conn-feed-false");
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "warning",
          summary: "Sync running slow — 3 retries last hour",
        },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.tier).not.toBe("feed");
  });

  it("does not stamp tier:'feed' when connection_id points at a missing item", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: "0192abc1-2345-7000-8000-000000000000",
          severity: "info",
          summary: "Activity for a stray ref",
        },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.tier).not.toBe("feed");
  });

  it("rejects a client-supplied tier on system.activity", async () => {
    const connectionId = await createConnection(true, "conn-client-tier-test");
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        tier: "feed",
        properties: {
          connection_id: connectionId,
          severity: "info",
          summary: "Client-initiated tier write — should be rejected",
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an invalid severity value", async () => {
    const connectionId = await createConnection(false, "conn-bad-severity");
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "catastrophic",
          summary: "Bad severity",
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("validation_error");
  });

  it("filters action_required activities via the regular filter DSL", async () => {
    const connectionId = await createConnection(false, "conn-action-filter");

    const a = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "action_required",
          summary: "Reauthorise calendar — token expired",
        },
      },
    });
    expect(a.status).toBe(201);

    const b = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "info",
          summary: "Routine completion",
        },
      },
    });
    expect(b.status).toBe(201);

    const listRes = await request(
      ctx.app,
      "GET",
      `/items?type=system.activity&filter=${encodeURIComponent('properties.severity eq "action_required"')}`,
      { key: ctx.adminKey },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ListResponse;
    const severities = list.data.map((r) => r.properties.severity as string);
    expect(severities.length).toBeGreaterThanOrEqual(1);
    for (const s of severities) {
      expect(s).toBe("action_required");
    }
  });
});
