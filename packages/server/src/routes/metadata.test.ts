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

interface ItemResponse {
  item: { id: string };
}

async function createItemWithTags(tags: string[]): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "core.note",
      properties: { body: `tags-${tags.join("-")}-${String(Math.random())}` },
      tags,
    },
  });
  return ((await res.json()) as ItemResponse).item.id;
}

describe("GET /metadata/tags", () => {
  it("rejects unauthenticated", async () => {
    const res = await request(ctx.app, "GET", "/metadata/tags");
    expect(res.status).toBe(401);
  });

  it("returns distinct tags with counts, sorted by count desc", async () => {
    await createItemWithTags(["alpha", "beta"]);
    await createItemWithTags(["alpha", "gamma"]);
    await createItemWithTags(["alpha"]);

    const res = await request(ctx.app, "GET", "/metadata/tags", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tags: { tag: string; count: number }[];
    };
    const lookup = new Map(data.tags.map((t) => [t.tag, t.count]));
    expect(lookup.get("alpha") ?? 0).toBeGreaterThanOrEqual(3);
    expect(lookup.get("beta") ?? 0).toBeGreaterThanOrEqual(1);
    expect(lookup.get("gamma") ?? 0).toBeGreaterThanOrEqual(1);
    // Sorted by count desc; alpha should appear before its single-use peers.
    const alphaIdx = data.tags.findIndex((t) => t.tag === "alpha");
    const betaIdx = data.tags.findIndex((t) => t.tag === "beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it("excludes trashed items", async () => {
    const id = await createItemWithTags(["only-on-trashed-item"]);
    // Confirm tag visible while active.
    let res = await request(ctx.app, "GET", "/metadata/tags", {
      key: ctx.adminKey,
    });
    let data = (await res.json()) as { tags: { tag: string }[] };
    expect(data.tags.some((t) => t.tag === "only-on-trashed-item")).toBe(true);

    // Trash the item.
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.adminKey });

    res = await request(ctx.app, "GET", "/metadata/tags", {
      key: ctx.adminKey,
    });
    data = (await res.json()) as { tags: { tag: string }[] };
    expect(data.tags.some((t) => t.tag === "only-on-trashed-item")).toBe(false);
  });
});
