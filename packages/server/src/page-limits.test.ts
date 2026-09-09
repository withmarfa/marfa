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
 * `ItemStore.list` guards its pagination with `throw new Error("unreachable:
 * hasMore but data is empty")`. That line was reachable: the clamp did not
 * floor, `0` is not nullish so the default never fired, `LIMIT 1` returned a
 * row, and the page sliced to nothing. It had never fired because thirteen
 * separate restatements of the bound all happened to refuse `0` upstream —
 * which is a property of the callers, not of the guard.
 *
 * These assert the door's refusal and the store's floor separately, because
 * they are different guarantees and the first is what has been hiding the
 * second.
 */
describe("the page bound", () => {
  it("refuses a zero limit at the door rather than clamping it", async () => {
    const res = await request(ctx.app, "GET", "/items?limit=0", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a limit above the bound", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=${String(MAX_PAGE_LIMIT + 1)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
  });

  it("accepts the bound itself, so the refusal is off by nothing", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=${String(MAX_PAGE_LIMIT)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
  });

  it("floors at the minimum in the store, where no door is in the way", async () => {
    // The guarantee the door has been standing in for. Reached directly,
    // because the route refuses zero before a handler runs — which is exactly
    // why this had never been exercised.
    for (const marker of ["floor-a", "floor-b"]) {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
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
    expect(page.has_more).toBe(true);
  });

  it("uses the default when the caller names no limit", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBeLessThanOrEqual(DEFAULT_PAGE_LIMIT);
  });
});
