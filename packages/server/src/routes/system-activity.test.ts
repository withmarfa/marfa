import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

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

/**
 * Seed the Connection an activity row will be written against.
 *
 * Written through the storage layer rather than `POST /items`, because
 * `system.*` is a reserved namespace no credential a space holds may write
 * into — a Connection is created by the install pipeline, not by a caller.
 *
 * Stamping `source` makes the dedup index forgive repeated runs that happen
 * to share a space; pass-through unknown property `feed_activity` is
 * preserved by the loose-object validation.
 */
async function createConnection(
  feedActivity: boolean,
  source: string,
): Promise<string> {
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      source,
      properties: {
        kind: "integration",
        status: "active",
        granted_at: "2026-04-30T00:00:00.000Z",
        feed_activity: feedActivity,
      },
    },
    ctx.spaceId,
  );
  return connection.id;
}

/**
 * A runtime credential bound to `connectionId`.
 *
 * The `system.activity` carve-out is the only way a row of that type reaches
 * `POST /items` at all, and it admits a runtime credential writing for its
 * own connection and nothing else. So the credential each write goes through
 * has to be the one bound to the connection the row claims — which is also
 * the shape the integration runtime mints per dispatch.
 */
async function runtimeKeyFor(connectionId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rawKey = `marfa_k1_activity_${suffix}`;
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: `activity-${suffix}`,
      source: `activity-${suffix}`,
      type_permissions: { "system.activity": "write" },
      connection_id: connectionId,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: `integration:acme.activity.${suffix}`,
    },
    hashApiKey(rawKey, TEST_API_KEY_SALT),
    ctx.spaceId,
  );
  return rawKey;
}

describe("system.activity — schema + feed-tier exception", () => {
  it("creates an activity referencing a connection with feed_activity=true and stamps tier:'feed'", async () => {
    const connectionId = await createConnection(true, "conn-feed-true");
    const res = await request(ctx.app, "POST", "/items", {
      key: await runtimeKeyFor(connectionId),
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
      key: ctx.spaceKey,
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
      key: await runtimeKeyFor(connectionId),
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
    // The credential is bound to the same id the row claims, so attribution
    // is satisfied and what is under test is the feed lookup finding nothing
    // — a Connection row that was deleted out from under its own runtime
    // credential is exactly how this arises.
    const strayConnectionId = "0192abc1-2345-7000-8000-000000000000";
    const res = await request(ctx.app, "POST", "/items", {
      key: await runtimeKeyFor(strayConnectionId),
      body: {
        type: "system.activity",
        properties: {
          connection_id: strayConnectionId,
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
      key: await runtimeKeyFor(connectionId),
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
      key: await runtimeKeyFor(connectionId),
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
    expect(body.error.code).toBe("invalid_properties");
  });

  it("filters action_required activities via the regular filter DSL", async () => {
    const connectionId = await createConnection(false, "conn-action-filter");
    const runtimeKey = await runtimeKeyFor(connectionId);

    const a = await request(ctx.app, "POST", "/items", {
      key: runtimeKey,
      body: {
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: "action_required",
          summary: "Reauthorize calendar — token expired",
        },
      },
    });
    expect(a.status).toBe(201);

    const b = await request(ctx.app, "POST", "/items", {
      key: runtimeKey,
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
      { key: ctx.spaceKey },
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
