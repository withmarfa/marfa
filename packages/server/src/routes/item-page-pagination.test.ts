import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";
import { itemWrites } from "../storage/item-writes.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  for (let i = 0; i < 31; i++)
    await itemWrites(ctx.storage).create({
      writer: null,
      type: "core.note",
      properties: {
        title: `${i % 3 ? "Match" : "Other"} ${String(i).padStart(2, "0")}`,
        body: "Match body only",
      },
    });
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

it.each([
  {
    query: "type=core.note&page=3",
    names: ["Match 10", "Other 09", "Match 08"],
  },
  {
    query: "type=core.note&q=Match&page=2",
    names: ["Match 14", "Match 13", "Match 11"],
  },
  { query: "type=core.note&page=999999999", names: ["Other 00"] },
])(
  "reads $query without replaying previous pages",
  async ({ query, names }) => {
    const list = vi.spyOn(ctx.storage.items, "listSummaries");
    try {
      const response = await ctx.ownerRequest(`/auth/owner/items?${query}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const name of names) expect(html).toContain(name);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore();
    }
  },
);

it("redirects an exhausted search page with one scan", async () => {
  const witness = await ctx.ownerRequest(
    "/auth/owner/items?type=core.note&q=Match",
  );
  expect(await witness.text()).toContain("Match 29");
  const list = vi.spyOn(ctx.storage.items, "listSummaries");
  try {
    const response = await ctx.ownerRequest(
      "/auth/owner/items?type=core.note&q=Match&page=999999999",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/owner/items?type=core.note&q=Match",
    );
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    list.mockRestore();
  }
});
