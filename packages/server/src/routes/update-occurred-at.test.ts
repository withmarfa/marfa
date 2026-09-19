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

describe("PATCH /items/:id — occurred_at field", () => {
  it("overrides the item's own time", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "ts-override" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string; version: number };
    };

    const newTs = "2001-09-11T08:46:00.000Z";
    const patchRes = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { occurred_at: newTs, version: item.version },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    const fetched = (await getRes.json()) as {
      item: { occurred_at: string };
    };
    expect(fetched.item.occurred_at).toBe(newTs);
  });

  it("rejects non-ISO strings", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "ts-invalid" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string; version: number };
    };

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { occurred_at: "not an ISO date", version: item.version },
    });
    expect(res.status).toBe(400);
  });
});
