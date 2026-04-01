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

describe("threads", () => {
  it("creates a thread", async () => {
    const res = await request(ctx.app, "POST", "/threads", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { thread: Record<string, unknown> };
    expect(data.thread).toHaveProperty("id");
    expect(data.thread).toHaveProperty("created_at");
  });

  it("lists threads", async () => {
    const res = await request(ctx.app, "GET", "/threads", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("data");
    expect(data).toHaveProperty("has_more");
  });

  it("gets thread with items", async () => {
    // Create thread
    const threadRes = await request(ctx.app, "POST", "/threads", {
      key: ctx.adminKey,
    });
    const threadData = (await threadRes.json()) as { thread: Record<string, unknown> };
    const threadId = threadData.thread.id as string;

    // Add item to thread
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "In thread" },
        thread_id: threadId,
      },
    });

    // Get thread with items
    const res = await request(ctx.app, "GET", `/threads/${threadId}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("thread");
    expect(data).toHaveProperty("items");
    const items = data.items as unknown[];
    expect(items.length).toBe(1);
  });
});
