import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "./page-limits.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * The bound, and the line that says it cannot be reached.
 *
 * `ItemStore.list` guards its pagination with a throw for a page that has
 * more to follow and no rows. A `limit` of `0` would reach it if the store's
 * clamp did not floor, since `0` is not nullish and `LIMIT 1` still returns a
 * row. The doors refuse `0` upstream, which is a property of the callers and
 * not of the guard, so these assert the door's refusal and the store's floor
 * separately.
 */
describe("the page bound", () => {
  it("refuses a zero limit at the door rather than clamping it", async () => {
    const res = await request(ctx.app, "GET", "/items?limit=0", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a limit above the bound", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=${String(MAX_PAGE_LIMIT + 1)}`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(400);
  });

  it("accepts the bound itself, so the refusal is off by nothing", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=${String(MAX_PAGE_LIMIT)}`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
  });

  it("floors at the minimum in the store, where no door is in the way", async () => {
    // The guarantee the door has been standing in for. Reached directly,
    // because the route refuses zero before a handler runs — which is exactly
    // why this had never been exercised.
    for (const marker of ["floor-a", "floor-b"]) {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { body: `page-bound-${marker}` },
          tags: ["page-bound-floor"],
        },
      });
      expect(created.status).toBe(201);
    }

    const page = await ctx.storage.items.list({
      limit: 0,
      tags: ["page-bound-floor"],
    });

    // One row rather than a throw, and rather than an empty page claiming
    // there is more.
    expect(page.data).toHaveLength(MIN_PAGE_LIMIT);
    expect(page.next_cursor).not.toBeNull();
  });

  it("uses the default when the caller names no limit", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBeLessThanOrEqual(DEFAULT_PAGE_LIMIT);
  });
});
