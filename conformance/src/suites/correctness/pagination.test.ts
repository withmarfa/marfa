import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createSecondClient,
  createTestContext,
  getOwnerClient,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { itemsArchive } from "../../utils/archive.js";

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
    // An array rather than a set, so an item delivered twice counts twice.
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

  it("continues a cursor under another limit", async () => {
    const first = await client.listItems({ limit: 2, source: ctx.source });
    expect(first.ok).toBe(true);
    const next = await client.listItems({
      limit: 3,
      source: ctx.source,
      cursor: first.data.next_cursor!,
    });
    expect(next.ok).toBe(true);
    const all = await client.listItems({ limit: 5, source: ctx.source });
    expect(
      [...first.data.data, ...next.data.data].map((row) => row.id),
    ).toEqual(all.data.data.map((row) => row.id));
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

describe("the order of the listing", () => {
  const at = (hour: number) =>
    `2020-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  let ordered: MarfaClient;
  let source: string;
  let newestFirst: string[];
  const ids = async (query: string): Promise<string[]> => {
    const page = await ordered.rawRequest<{ data: { id: string }[] }>(
      `/items?source=${encodeURIComponent(source)}&${query}`,
    );
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    return page.data.data.map((row) => row.id);
  };

  beforeAll(async () => {
    ordered = await createSecondClient(ctx, "order");
    source = `${ctx.source}-order`;
    // No write door gives two items one `created_at`, but an archive may. The
    // items are written in ascending ID order, so a tie that fell to the order
    // of the writes would not come out descending.
    const tied = [generateId(), generateId(), generateId()].sort();
    const [older, newer] = [generateId(), generateId()];
    const restored = await getOwnerClient().restoreArchive(
      itemsArchive(
        [
          { id: newer!, created_at: at(3), updated_at: at(1) },
          ...tied.map((id, i) => ({
            id,
            created_at: at(2),
            updated_at: at(4 + i),
          })),
          { id: older!, created_at: at(1), updated_at: at(9) },
        ].map((row) => ({
          ...row,
          type: "core.note",
          source,
          properties: { body: "listing order" },
        })),
      ),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.imported).toBe(5);
    newestFirst = [newer!, ...[...tied].reverse(), older!];
    for (const id of newestFirst) trackItem(ctx, id);
    for (const id of tied) {
      const row = await ordered.getItem(id);
      expect(row.data.item.created_at).toBe(at(2));
    }
  });

  it("orders a listing with no sort by created_at, then by id in the same direction", async () => {
    expect(await ids("")).toEqual(newestFirst);
    expect(await ids("sort=created_at")).toEqual(newestFirst);
    const oldestFirst = [...newestFirst].reverse();
    expect(await ids("direction=asc")).toEqual(oldestFirst);
    expect(await ids("sort=created_at&direction=asc")).toEqual(oldestFirst);

    // The cursor keeps its place inside a tie.
    const walked: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await ordered.listItems({
        source,
        limit: 1,
        cursor: cursor ?? undefined,
      });
      expect(page.ok).toBe(true);
      walked.push(...page.data.data.map((row) => row.id));
      cursor = page.data.next_cursor;
    } while (cursor);
    expect(walked).toEqual(newestFirst);
  });

  it("orders a listing by updated_at when it names that sort", async () => {
    const [newer, ...others] = newestFirst;
    const older = others.pop();
    const latestFirst = [older, ...others, newer];
    expect(await ids("sort=updated_at")).toEqual(latestFirst);
    expect(await ids("sort=updated_at&direction=asc")).toEqual(
      [...latestFirst].reverse(),
    );
  });

  it("refuses a sort or direction it does not take", async () => {
    for (const [query, path] of [
      ["sort=nope", "sort"],
      ["sort=relevance", "sort"],
      ["sort=trashed_at", "sort"],
      ["sort=properties.Title", "sort"],
      ["sort=properties.a-b", "sort"],
      ["direction=up", "direction"],
    ] as const) {
      const refused = await ordered.rawRequest(
        `/items?source=${encodeURIComponent(source)}&${query}`,
      );
      expect(refused.status, query).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.errors).toMatchObject([{ path }]);
    }
    // The witness: the door takes each of the orders it declares.
    expect(await ids("sort=occurred_at")).toHaveLength(newestFirst.length);
    expect(await ids("sort=properties.body_2")).toHaveLength(
      newestFirst.length,
    );
  });
});

describe("the order of a catch-up", () => {
  const at = (hour: number) =>
    `2020-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`;

  it("orders a catch-up by updated_at, then by id, ascending", async () => {
    const catchUp = await createSecondClient(ctx, "catchup");
    const source = `${ctx.source}-catchup`;
    // Written newest first, with the tied items in descending ID order, so an
    // order that fell to the order of the writes would not come out ascending.
    const tied = [generateId(), generateId(), generateId()].sort();
    const [late, early, before] = [generateId(), generateId(), generateId()];
    const restored = await getOwnerClient().restoreArchive(
      itemsArchive(
        [
          { id: late!, updated_at: at(9) },
          ...[...tied].reverse().map((id) => ({ id, updated_at: at(5) })),
          { id: early!, updated_at: at(2) },
          { id: before!, updated_at: at(1) },
        ].map((row) => ({
          ...row,
          created_at: at(1),
          type: "core.note",
          source,
          properties: { body: "catch-up order" },
        })),
      ),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.imported).toBe(6);
    for (const id of [late!, early!, before!, ...tied]) trackItem(ctx, id);
    const expected = [early!, ...tied, late!];

    const scope = `source=${encodeURIComponent(source)}&updated_after=${at(2)}`;
    const page = await catchUp.rawRequest<{ data: { id: string }[] }>(
      `/items?${scope}`,
    );
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    expect(page.data.data.map((row) => row.id)).toEqual(expected);

    // The cursor keeps its place inside the tie.
    const walked: string[] = [];
    let cursor: string | null | undefined;
    do {
      const next = await catchUp.rawRequest<{
        data: { id: string }[];
        next_cursor: string | null;
      }>(
        `/items?${scope}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      walked.push(...next.data.data.map((row) => row.id));
      cursor = next.data.next_cursor;
    } while (cursor);
    expect(walked).toEqual(expected);
  });
});

describe("the page limit", () => {
  const LISTING_MAX = 500;
  const SEARCH_MAX = 100;
  let word: string;
  let wide: MarfaClient;
  let wideSource: string;

  beforeAll(async () => {
    // A source of its own, so the items the other cases count are left alone.
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

  it("takes a limit of 500, reads 501 as 500 and refuses 0, on the listing", async () => {
    const path = (limit: number) =>
      `/items?source=${encodeURIComponent(wideSource)}&limit=${String(limit)}`;
    // More items are held than the largest page, so a full page is the limit
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

    // A client built for a larger page reads the bound and walks on by the
    // cursor, so a larger limit is read as the bound and not refused.
    const over = await wide.rawRequest<{
      data: unknown[];
      next_cursor: string | null;
    }>(path(LISTING_MAX + 1));
    expect(over.status, JSON.stringify(over.error)).toBe(200);
    expect(over.data.data).toHaveLength(LISTING_MAX);
    expect(over.data.next_cursor).not.toBeNull();

    const refused = await wide.rawRequest<unknown>(path(0));
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.errors).toMatchObject([
      { path: "limit" },
    ]);
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
