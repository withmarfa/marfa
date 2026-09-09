import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { Item } from "@withmarfa/shared";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// system.connection shape tests. Exercises the integration-specific fields:
// schema acceptance, persistence, and enum rejection.
//
// The rows go in through the storage layer rather than POST /items, because
// no credential can write a reserved namespace: the operator gate admits only
// `is_operator`, and the operator key's own type permissions are empty, so the
// platform's own machinery writes these rows through storage. The store
// validates properties against the type schema on the way in, so a refusal
// below is the product's and not the fixture's. Reads are not fenced, so the
// persistence check still goes through the API.

interface ItemResponse {
  item: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
  };
  metadata: { item_id: string; tags: string[]; extensions: object };
}

const VALID_INTEGRATION_PROPERTIES = {
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
};

let seq = 0;

/** Write a connection row into the context's space, as the platform does. */
function seed(properties: Record<string, unknown>): Promise<Item> {
  seq += 1;
  return ctx.storage.items.create(
    {
      type: "system.connection",
      properties,
      source: `connection-shape-${String(seq)}`,
    },
    ctx.spaceId,
  );
}

describe("system.connection — kind: integration shape", () => {
  it("accepts and persists every integration-shape field", async () => {
    const created = await seed(VALID_INTEGRATION_PROPERTIES);
    expect(created.type).toBe("system.connection");
    const props = created.properties;
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

    const getRes = await request(ctx.app, "GET", `/items/${created.id}`, {
      key: ctx.spaceKey,
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as ItemResponse;
    expect(fetched.item.properties).toEqual(props);
  });

  it("rejects an invalid runtime_status value", async () => {
    await expect(
      seed({
        ...VALID_INTEGRATION_PROPERTIES,
        runtime_status: "totally-fine",
      }),
    ).rejects.toMatchObject({ code: "invalid_properties" });
  });

  it("rejects an invalid direction value", async () => {
    await expect(
      seed({ ...VALID_INTEGRATION_PROPERTIES, direction: "diagonal" }),
    ).rejects.toMatchObject({ code: "invalid_properties" });
  });

  it("rejects an invalid kind value", async () => {
    await expect(
      seed({ ...VALID_INTEGRATION_PROPERTIES, kind: "future-kind" }),
    ).rejects.toMatchObject({ code: "invalid_properties" });
  });

  it("accepts feed_activity: true (the per-Connection feed-tier toggle)", async () => {
    const created = await seed({
      ...VALID_INTEGRATION_PROPERTIES,
      feed_activity: true,
    });
    expect(created.properties.feed_activity).toBe(true);
  });

  it("regression: app kind still validates", async () => {
    const created = await seed({
      kind: "app",
      client_id: "client-test-123",
      scopes: ["core.note:read"],
      status: "active",
      granted_at: "2026-04-30T00:00:00.000Z",
    });
    expect(created.properties.kind).toBe("app");
  });
});
