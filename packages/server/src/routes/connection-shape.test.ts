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

// PR 2 of workstream 2: extends system.connection for the
// `integration` kind. WS1 already declared the kind value
// in the enum but populated no shape. These tests exercise the new fields
// end-to-end via POST /items + GET /items to confirm the schema accepts
// them, persists them, and rejects invalid enum values.
//
// Authority: writes to system.* require is_platform: true on the
// credential. The bootstrap admin key created by createTestContext is
// platform, so it can write any system type. There is no separate
// /connections route in WS2 — the shape is reachable through the
// generic items API, gated by the existing platform-credential check.

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

    // Round-trip: fetch by id and confirm the same shape comes back.
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

  // The new connector-specific fields are additive; existing
  // app items must continue to validate without them.
  it("regression: app kind still validates with the WS1 shape", async () => {
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
