import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createSecondClient,
  createTestContext,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
const createdIds: string[] = [];

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "pagination"));

  for (let i = 0; i < 15; i++) {
    const note = createNote({
      source: ctx.source,
      properties: {
        title: `Pagination item ${i}`,
        body: `Content for item ${i}`,
      },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    createdIds.push(r.data.item.id);
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("pagination correctness", () => {
  it("basic pagination: limit restricts result count and signals more", async () => {
    const page = await client.listItems({ limit: 3, source: ctx.source });
    expect(page.ok).toBe(true);
    await expectMatchesSchema("GET", "/items", 200, page.data);
    expect(page.data.data.length).toBe(3);
    expect(Object.keys(page.data).sort()).toEqual(["data", "next_cursor"]);
    expect(page.data.next_cursor).not.toBeNull();
  });

  it("cursor continuation delivers every item exactly once", async () => {
    // An array rather than a set, so a row delivered twice counts twice.
    const delivered: string[] = [];
    let cursor: string | undefined = undefined;
    const limit = 5;
    let pages = 0;

    while (pages < 100) {
      const page = await client.listItems({
        limit,
        cursor,
        source: ctx.source,
      });
      expect(page.ok).toBe(true);
      delivered.push(...page.data.data.map((item) => item.id));

      pages++;
      if (page.data.next_cursor === null) break;
      cursor = page.data.next_cursor ?? undefined;
    }

    expect(delivered.length).toBe(15);
    expect(new Set(delivered).size).toBe(15);
    expect([...delivered].sort()).toEqual([...createdIds].sort());
  });

  it("cursor is opaque and enables next page retrieval", async () => {
    const page1 = await client.listItems({ limit: 5, source: ctx.source });
    expect(page1.ok).toBe(true);
    expect(page1.data.next_cursor).not.toBeNull();
    expect(typeof page1.data.next_cursor).toBe("string");

    const page2 = await client.listItems({
      limit: 5,
      cursor: page1.data.next_cursor!,
      source: ctx.source,
    });
    expect(page2.ok).toBe(true);
    expect(page2.data.data.length).toBe(5);
    const page1Ids = new Set(page1.data.data.map((i) => i.id));
    for (const item of page2.data.data) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });

  it("the last page answers next_cursor: null", async () => {
    let cursor: string | undefined = undefined;
    let lastPage;
    for (let i = 0; i < 100; i++) {
      lastPage = await client.listItems({
        limit: 10,
        cursor,
        source: ctx.source,
      });
      if (lastPage.data.next_cursor === null) break;
      cursor = lastPage.data.next_cursor ?? undefined;
    }
    expect(lastPage!.ok).toBe(true);
    expect(lastPage!.data.next_cursor).toBeNull();
  });

  it("refuses a cursor issued by another listing or ordering", async () => {
    // The one thing an opaque cursor still says is where it came from.
    // Every ordering compares an ISO timestamp, so a cursor honored under
    // another one would answer a page that is simply not the next page,
    // with nothing to say so.
    const byUpdate = await client.listItems({
      limit: 5,
      source: ctx.source,
      sort: "updated_at",
    });
    expect(byUpdate.ok).toBe(true);
    const cursor = byUpdate.data.next_cursor!;
    expect(typeof cursor).toBe("string");

    // The witness: the ordering that minted it continues on it.
    const next = await client.listItems({
      limit: 5,
      source: ctx.source,
      sort: "updated_at",
      cursor,
    });
    expect(next.ok).toBe(true);
    expect(next.data.data.length).toBe(5);
    const shown = new Set(byUpdate.data.data.map((item) => item.id));
    for (const item of next.data.data) expect(shown.has(item.id)).toBe(false);

    const otherOrdering = await client.listItems({
      limit: 5,
      source: ctx.source,
      sort: "created_at",
      cursor,
    });
    expect(otherOrdering.ok).toBe(false);
    expect(otherOrdering.status).toBe(400);
    expect(otherOrdering.error?.error.code).toBe("validation_error");

    const otherListing = await client.listEdges({ limit: 5, cursor });
    expect(otherListing.ok).toBe(false);
    expect(otherListing.status).toBe(400);
    expect(otherListing.error?.error.code).toBe("validation_error");
  });

  it("a nonexistent type is refused rather than answered with an empty page", async () => {
    // An empty page is the one answer a client cannot tell from an empty
    // dataset, so a concrete type the server does not know is a 400.
    const page = await client.listItems({
      type: "core.nonexistent_pagination_type",
    });
    expect(page.ok).toBe(false);
    expect(page.status).toBe(400);
    expect(page.error?.error.code).toBe("unknown_type");
  });

  it("search respects limit parameter", async () => {
    // Fifteen seeded titles match, so the limit is what bounds the answer.
    const page = await client.search("Pagination", { limit: 2 });
    expect(page.ok).toBe(true);
    expect(page.data.data.length).toBe(2);
  });
});

describe("the page limit", () => {
  const LISTING_MAX = 200;
  const SEARCH_MAX = 100;
  let word: string;
  let wide: MarfaClient;
  let wideSource: string;

  beforeAll(async () => {
    // A source of its own, so the rows the other cases count are left alone.
    wide = await createSecondClient(ctx, "wide");
    wideSource = `${ctx.source}-wide`;
    word = `limitbounds${ctx.runId}`;
    const seeded = await wide.bulkItems({
      items: Array.from({ length: LISTING_MAX + 1 }, (_, i) => ({
        type: "core.note",
        source: wideSource,
        properties: { title: word, body: `${word} ${String(i)}` },
      })),
    });
    expect(seeded.status, JSON.stringify(seeded.error)).toBe(200);
    expect(seeded.data.counts.created).toBe(LISTING_MAX + 1);
    for (const result of seeded.data.results) trackItem(ctx, String(result.id));
  });

  it("takes a limit of 200 and refuses 201 and 0, on the listing", async () => {
    const path = (limit: number) =>
      `/items?source=${encodeURIComponent(wideSource)}&limit=${String(limit)}`;
    // More rows are held than the largest page, so a page of 200 is the limit
    // honored and not the listing running out.
    const widest = await wide.rawRequest<{
      data: unknown[];
      next_cursor: string | null;
    }>(path(LISTING_MAX));
    expect(widest.status, JSON.stringify(widest.error)).toBe(200);
    expect(widest.data.data).toHaveLength(LISTING_MAX);
    expect(widest.data.next_cursor).not.toBeNull();

    const narrowest = await wide.rawRequest<{ data: unknown[] }>(path(1));
    expect(narrowest.status).toBe(200);
    expect(narrowest.data.data).toHaveLength(1);

    for (const limit of [LISTING_MAX + 1, 0]) {
      const refused = await wide.rawRequest<unknown>(path(limit));
      expect(refused.status, `limit ${String(limit)}`).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.errors).toMatchObject([
        { path: "limit" },
      ]);
    }
  });

  it("takes a limit of 100 and refuses 101 and 0, on the search", async () => {
    const path = (limit: number) => `/search?q=${word}&limit=${String(limit)}`;
    const widest = await wide.rawRequest<{
      data: unknown[];
      next_cursor: string | null;
    }>(path(SEARCH_MAX));
    expect(widest.status, JSON.stringify(widest.error)).toBe(200);
    expect(widest.data.data).toHaveLength(SEARCH_MAX);
    expect(widest.data.next_cursor).not.toBeNull();

    const narrowest = await wide.rawRequest<{ data: unknown[] }>(path(1));
    expect(narrowest.status).toBe(200);
    expect(narrowest.data.data).toHaveLength(1);

    for (const limit of [SEARCH_MAX + 1, 0]) {
      const refused = await wide.rawRequest<unknown>(path(limit));
      expect(refused.status, `limit ${String(limit)}`).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.errors).toMatchObject([
        { path: "limit" },
      ]);
    }
  });
});
