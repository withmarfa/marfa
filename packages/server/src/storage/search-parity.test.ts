/**
 * Full-text search over the FTS5 virtual table (`items_fts`), populated at
 * write time from the shared `extractSearchableText` helper, which decides
 * what text contributes to FTS for an item.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

interface SearchHit {
  item: { id: string; type: string };
  relevance_score: number;
}

async function search(query: string): Promise<SearchHit[]> {
  const res = await request(
    ctx.app,
    "GET",
    `/search?q=${encodeURIComponent(query)}`,
    { key: ctx.spaceKey },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: SearchHit[] };
  return body.results;
}

describe("FTS dialect parity", () => {
  it("indexes the four core fields end-to-end", async () => {
    const { item: a } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: {
            title: "Pelican",
            body: "Brown bird that fishes for breakfast.",
          },
        },
      })
    ).json()) as { item: { id: string } };
    const { item: b } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: {
            title: "Albatross",
            body: "Wingspan greater than three meters.",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // title hit
    const hitsTitle = await search("pelican");
    const titleIds = hitsTitle.map((h) => h.item.id);
    expect(titleIds).toContain(a.id);
    expect(titleIds).not.toContain(b.id);

    // body hit
    const hitsBody = await search("wingspan");
    const bodyIds = hitsBody.map((h) => h.item.id);
    expect(bodyIds).toContain(b.id);
    expect(bodyIds).not.toContain(a.id);
  });

  it("respects per-type searchable: false on string fields (custom type, long-tail field)", async () => {
    // Register a custom type with one searchable string field and one
    // explicitly-non-searchable string field. The non-searchable
    // content must NOT surface in search results.
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: "demo.t015_optout",
        version: 1,
        fields: {
          public_blurb: { type: "string", description: "Visible in search" },
          internal_secret: {
            type: "string",
            description: "Should NOT surface in search",
            searchable: false,
          },
        },
      },
    });
    expect(reg.status).toBe(201);

    const { item: secretItem } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "demo.t015_optout",
          properties: {
            public_blurb: "Aardvark gardener",
            internal_secret: "Quagga forensics",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // public_blurb hits
    const publicHits = await search("aardvark");
    expect(publicHits.map((h) => h.item.id)).toContain(secretItem.id);

    // internal_secret content should NOT match — the field is
    // searchable: false, so it must not be indexed at write time.
    const secretHits = await search("quagga");
    expect(secretHits.map((h) => h.item.id)).not.toContain(secretItem.id);
  });

  it("respects searchable: false on a core field (title) for a custom type that opts out", async () => {
    // Custom type that overrides the core `title` field with
    // searchable: false. Demonstrates the opt-out works for the four
    // core fields too — `getSearchableStringFields` skips them
    // because they're core, but the indexer consults
    // `isFieldSearchableExcluded` for the same opt-out shape.
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: "demo.t015_title_optout",
        version: 1,
        fields: {
          title: { type: "string", searchable: false },
          body: { type: "string" },
        },
      },
    });
    expect(reg.status).toBe(201);

    const { item: created } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "demo.t015_title_optout",
          properties: {
            title: "Narwhal",
            body: "Marine mammal with a long tusk.",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // title is opted out → search on title content misses
    const titleHits = await search("narwhal");
    expect(titleHits.map((h) => h.item.id)).not.toContain(created.id);

    // body is still indexed — happy path still works
    const bodyHits = await search("tusk");
    expect(bodyHits.map((h) => h.item.id)).toContain(created.id);
  });

  it("re-indexes on update — the search_vector / FTS row reflects the latest state", async () => {
    const { item } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: { title: "Initial", body: "first" },
        },
      })
    ).json()) as { item: { id: string } };

    // Initial title hits
    expect((await search("initial")).map((h) => h.item.id)).toContain(item.id);

    // Update the title — the new title should hit, the old shouldn't.
    const upd = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: {
        properties: { title: "Updated", body: "second" },
      },
    });
    expect(upd.status).toBe(200);

    expect((await search("updated")).map((h) => h.item.id)).toContain(item.id);
    expect((await search("initial")).map((h) => h.item.id)).not.toContain(
      item.id,
    );
  });

  it("removes from index on hard delete", async () => {
    const { item } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: { title: "Ephemeral", body: "doomed" },
        },
      })
    ).json()) as { item: { id: string } };

    expect((await search("ephemeral")).map((h) => h.item.id)).toContain(
      item.id,
    );

    // Trash → purge (hard delete). Search must no longer match.
    const trash = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(trash.status).toBe(200);
    const purge = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: ctx.spaceKey,
    });
    expect(purge.status).toBe(200);

    expect((await search("ephemeral")).map((h) => h.item.id)).not.toContain(
      item.id,
    );
  });
});
