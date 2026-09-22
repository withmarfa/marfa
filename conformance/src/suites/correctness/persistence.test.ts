import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import {
  createNote,
  createBookmark,
  generateId,
} from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "persistence"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("persistence — multi-read-path verification", () => {
  it("item is retrievable by ID after creation", async () => {
    const note = createNote({
      source: ctx.source,
      properties: {
        title: "Persistence check",
        body: `marker-${generateId()}`,
      },
    });

    const created = await client.createItem(note);
    expect(created.status).toBe(201);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);
    await expectMatchesSchema("POST", "/items", 201, created.data);
    expect(itemId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.isNaN(Date.parse(created.data.item.created_at))).toBe(false);
    expect(created.data.item.version).toBe(1);
    expect(created.data.metadata.tags).toEqual([]);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}", 200, fetched.data);
    expect(fetched.data.item.id).toBe(itemId);
    expect(fetched.data.item.type).toBe("core.note");
    expect(fetched.data.item.properties).toEqual(note.properties);
  });

  it("item appears in listItems after creation", async () => {
    const note = createNote({ source: ctx.source });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    const list = await client.listItems({ type: "core.note", limit: 100 });
    expect(list.ok).toBe(true);
    const found = list.data.data.some((i) => i.id === itemId);
    expect(found).toBe(true);
  });

  it("item appears in search results after creation", async () => {
    const marker = `evalmarker-${generateId()}`;
    const note = createNote({
      source: ctx.source,
      properties: {
        title: marker,
        body: `This note contains ${marker} for search verification`,
      },
    });

    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    // Allow search index to catch up
    await new Promise((r) => setTimeout(r, 1000));

    const results = await client.search(marker, { limit: 50 });
    expect(results.ok).toBe(true);
    const found = results.data.data.some(
      (r) => r.item.id === created.data.item.id,
    );
    expect(found).toBe(true);
  });

  it("item data is consistent across getItem and listItems", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "Consistency check", body: `check-${generateId()}` },
    });

    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    const byId = await client.getItem(itemId);
    expect(byId.ok).toBe(true);

    const byList = await client.listItems({ type: "core.note", limit: 100 });
    expect(byList.ok).toBe(true);
    const fromList = byList.data.data.find((i) => i.id === itemId);
    expect(fromList).toBeDefined();

    expect(byId.data.item.properties).toEqual(fromList!.properties);
    expect(byId.data.item.type).toBe(fromList!.type);
    expect(byId.data.item.state).toBe(fromList!.state);
    expect(byId.data.item.created_at).toBe(fromList!.created_at);
  });

  it("all fields are preserved after round-trip", async () => {
    const properties = {
      title: "Field preservation test",
      body: `preserve-${generateId()}`,
    };

    const note = createNote({
      source: ctx.source,
      source_id: `preserve-${generateId()}`,
      properties,
      tags: ["preserve-test", "round-trip"],
    });

    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties).toEqual(properties);
    expect(fetched.data.item.source).toBe(ctx.source);
    expect(fetched.data.metadata.tags).toContain("preserve-test");
    expect(fetched.data.metadata.tags).toContain("round-trip");
  });
});

describe("search correctness", () => {
  it("search for distinctive text returns matching items", async () => {
    const marker = `searchtest-${generateId()}`;

    const createdIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const note = createNote({
        source: ctx.source,
        source_id: `search-${marker}-${i}`,
        properties: {
          title: `Test ${i}`,
          body: `Document ${i} contains ${marker} for search`,
        },
      });
      const r = await client.createItem(note);
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      createdIds.push(r.data.item.id);
    }

    await new Promise((r) => setTimeout(r, 1000));

    const results = await client.search(marker, { limit: 50 });
    expect(results.ok).toBe(true);

    const foundIds = results.data.data.map((r) => r.item.id);
    for (const id of createdIds) {
      expect(foundIds).toContain(id);
    }
  });

  it("search for nonexistent string returns empty results", async () => {
    const nonsense = `zzz-nonexistent-${generateId()}-zzz`;
    const results = await client.search(nonsense, { limit: 50 });
    expect(results.ok).toBe(true);
    expect(results.data.data.length).toBe(0);
  });

  it("type-filtered search only returns matching types", async () => {
    const marker = `typesearch-${generateId()}`;

    const note = createNote({
      source: ctx.source,
      source_id: `tsearch-note-${marker}`,
      properties: { title: `Note with ${marker}`, body: `Contains ${marker}` },
    });
    const bookmark = createBookmark({
      source: ctx.source,
      source_id: `tsearch-bm-${marker}`,
      properties: {
        url: `https://example.com/${marker}`,
        title: `Bookmark with ${marker}`,
      },
    });

    const r1 = await client.createItem(note);
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);

    const r2 = await client.createItem(bookmark);
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);

    await new Promise((r) => setTimeout(r, 1000));

    const results = await client.search(marker, {
      type: "core.note",
      limit: 50,
    });
    expect(results.ok).toBe(true);

    const resultIds = results.data.data.map((r) => r.item.id);
    expect(resultIds).toContain(r1.data.item.id);
    expect(resultIds).not.toContain(r2.data.item.id);
  });

  it("refuses a search with no query", async () => {
    const r = await client.rawRequest("/search");
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("missing_required_field");
  });
});
