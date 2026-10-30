import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  cleanupTestContext,
} from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_LISTING_LIMIT,
  MIN_PAGE_LIMIT,
} from "./page-limits.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
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

  it("reads a limit above the bound as the bound, on the listings a device walks", async () => {
    // More rows than the bound, so a page of exactly the bound is the cap and
    // not the listing running out.
    const seeded = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: Array.from({ length: MAX_LISTING_LIMIT + 2 }, (_, i) => ({
          type: "core.note",
          properties: { body: `page-bound-cap-${String(i)}` },
          tags: ["page-bound-cap"],
        })),
      },
    });
    expect(seeded.status).toBe(200);
    const [hub, ...others] = (
      (await seeded.json()) as { results: { id: string }[] }
    ).results.map((row) => row.id);
    for (const edges of [
      others.map((id) => ({ source_id: hub, target_id: id })),
      others.map((id) => ({ source_id: id, target_id: hub })),
    ]) {
      const linked = await request(ctx.app, "POST", "/edges/bulk", {
        key: ctx.workingKey,
        body: { edges: edges.map((edge) => ({ ...edge, edge_type: "about" })) },
      });
      expect(linked.status, await linked.clone().text()).toBe(200);
    }

    const over = String(MAX_LISTING_LIMIT + 1);
    for (const path of [
      `/items?tags=page-bound-cap&limit=${over}`,
      `/edges?edge_type=about&limit=${over}`,
      `/items/${hub}/edges?edge_type=about&limit=${over}`,
      `/items/${hub}/backrefs?edge_type=about&limit=${over}`,
    ]) {
      const res = await request(ctx.app, "GET", path, {
        key: ctx.workingKey,
      });
      expect(res.status, path).toBe(200);
      const page = (await res.json()) as {
        data: unknown[];
        next_cursor: string | null;
      };
      expect(page.data, path).toHaveLength(MAX_LISTING_LIMIT);
      expect(page.next_cursor, path).not.toBeNull();
    }
  });

  it("refuses a limit above the bound on a door a device does not walk", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "page-bound-refused" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const path = (limit: number) =>
      `/items/${item.id}/versions?limit=${String(limit)}`;
    const atBound = await request(ctx.app, "GET", path(MAX_PAGE_LIMIT), {
      key: ctx.workingKey,
    });
    expect(atBound.status).toBe(200);
    const over = await request(ctx.app, "GET", path(MAX_PAGE_LIMIT + 1), {
      key: ctx.workingKey,
    });
    expect(over.status).toBe(400);
  });

  it("accepts the bound itself, so the refusal is off by nothing", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=${String(MAX_LISTING_LIMIT)}`,
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
