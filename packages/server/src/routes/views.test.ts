import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeItem } from "../storage/item-write.js";
import type { TestContext } from "../test-utils.js";
import {
  createTestContext,
  request,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

describe("the view door", () => {
  it("drops a setting the type does not declare when it changes a view", async () => {
    const created = await request(ctx.app, "POST", "/views", {
      key: ctx.workingKey,
      body: { title: "Reading", sort: [{ by: "title", direction: "asc" }] },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: { id: string; version: number };
    };
    // A view written before views held no layouts keeps them in storage.
    const stored = await writeItem(
      ctx.storage,
      { kind: "platform", by: null },
      {
        op: "update",
        id: item.id,
        version: item.version,
        properties: { layouts: [{ id: "main", kind: "list" }] },
      },
    );
    expect(stored.outcome).toBe("updated");
    const before = (await ctx.storage.items.get(item.id))!;
    expect(before.properties).toHaveProperty("layouts");

    const changed = await request(ctx.app, "PATCH", `/views/${item.id}`, {
      key: ctx.workingKey,
      body: { version: before.version, title: "Renamed" },
    });
    expect(changed.status).toBe(200);
    const after = (await ctx.storage.items.get(item.id))!;
    expect(after.properties).toEqual({
      title: "Renamed",
      sort: [{ by: "title", direction: "asc" }],
    });
  });
});
