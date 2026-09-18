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

describe("PATCH /items/:id — timestamp field", () => {
  it("overrides the user-meaningful timestamp", async () => {
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
      body: { timestamp: newTs, version: item.version },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    const fetched = (await getRes.json()) as {
      item: { timestamp: string };
    };
    expect(fetched.item.timestamp).toBe(newTs);
  });

  it("rejects non-ISO timestamp strings", async () => {
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
      body: { timestamp: "not an ISO date", version: item.version },
    });
    expect(res.status).toBe(400);
  });
});
