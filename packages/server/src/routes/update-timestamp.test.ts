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

describe("PATCH /items/:id — timestamp field", () => {
  it("overrides the user-meaningful timestamp", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ts-override" },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };

    const newTs = "2001-09-11T08:46:00.000Z";
    const patchRes = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      body: { timestamp: newTs },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    const fetched = (await getRes.json()) as {
      item: { timestamp: string };
    };
    expect(fetched.item.timestamp).toBe(newTs);
  });

  it("rejects non-ISO timestamp strings", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ts-invalid" },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      body: { timestamp: "not an ISO date" },
    });
    expect(res.status).toBe(400);
  });
});
