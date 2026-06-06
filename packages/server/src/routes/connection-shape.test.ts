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

// system.connection shape tests. Exercises connector-specific fields via POST /items + GET /items:
// schema acceptance, persistence, and enum rejection. Writes to system.* require is_platform: true;
// the bootstrap admin key from createTestContext satisfies that gate.

interface ItemResponse {
  item: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
  };
  metadata: { item_id: string; tags: string[]; extensions: object };
}

interface ErrorResponse {
  error: { code: string; message?: string };
}

const VALID_CONNECTOR = {
  type: "system.connection",
  properties: {
    kind: "integration",
    status: "active",
    granted_at: "2026-04-30T00:00:00.000Z",
    integration_ref: "integration.acme.calendar",
    credential_ref: "cred-abc-123",
    configuration: { calendar_id: "primary" },
    direction: "both",
    triggers: [{ type: "schedule", cron: "*/15 * * * *" }, { type: "webhook" }],
    runtime_status: "healthy",
    last_sync_at: "2026-04-30T00:00:00.000Z",
    next_run_at: "2026-04-30T00:15:00.000Z",
    feed_activity: false,
  },
};

describe("system.connection — kind: integration shape", () => {
  it("accepts and persists every connector-shape field", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: VALID_CONNECTOR,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.type).toBe("system.connection");
    const props = created.item.properties;
    expect(props.kind).toBe("integration");
    expect(props.integration_ref).toBe("integration.acme.calendar");
    expect(props.credential_ref).toBe("cred-abc-123");
    expect(props.configuration).toEqual({ calendar_id: "primary" });
    expect(props.direction).toBe("both");
    expect(props.triggers).toEqual([
      { type: "schedule", cron: "*/15 * * * *" },
      { type: "webhook" },
    ]);
    expect(props.runtime_status).toBe("healthy");
    expect(props.last_sync_at).toBe("2026-04-30T00:00:00.000Z");
    expect(props.next_run_at).toBe("2026-04-30T00:15:00.000Z");
    expect(props.feed_activity).toBe(false);

    const getRes = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as ItemResponse;
    expect(fetched.item.properties).toEqual(props);
  });

  it("rejects an invalid runtime_status value", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          ...VALID_CONNECTOR.properties,
          runtime_status: "totally-fine",
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an invalid direction value", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          ...VALID_CONNECTOR.properties,
          direction: "diagonal",
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an invalid kind value", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          ...VALID_CONNECTOR.properties,
          kind: "future-kind",
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("validation_error");
  });

  it("accepts feed_activity: true (the per-Connection feed-tier toggle)", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          ...VALID_CONNECTOR.properties,
          feed_activity: true,
        },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.properties.feed_activity).toBe(true);
  });

  it("regression: app kind still validates", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "client-test-123",
          scopes: ["core.note:read"],
          status: "active",
          granted_at: "2026-04-30T00:00:00.000Z",
        },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ItemResponse;
    expect(created.item.properties.kind).toBe("app");
  });
});
