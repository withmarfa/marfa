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

describe("GET /search auth gate", () => {
  it("rejects requests without a key", async () => {
    const res = await request(ctx.app, "GET", "/search?q=anything");
    expect(res.status).toBe(401);
  });
});

describe("GET /search happy path", () => {
  it("returns matching results", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Quokkas of the world. Adorable creatures." },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/search?q=quokkas&type=core.note",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: {
        item: { id: string; properties: Record<string, unknown> };
      }[];
    };
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0]?.item.properties.body).toContain("Quokkas");
  });
});

describe("GET /search library filter", () => {
  // Use a unique whole-word token shared by both items so the FTS query
  // matches them directly. Tokenisation is whitespace-based, so
  // substrings inside other words won't match — keep the token standalone.
  const sharedToken = `lib3query${String(Date.now())}`;

  beforeAll(async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `${sharedToken} library variant` },
        tier: "library",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `${sharedToken} feed variant` },
        tier: "feed",
      },
    });
  });

  it("returns both items when no library filter is supplied", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { id: string; tier: "library" | "feed" } }[];
    };
    const libraryFlags = new Set(data.results.map((r) => r.item.tier));
    expect(libraryFlags.has("library")).toBe(true);
    expect(libraryFlags.has("feed")).toBe(true);
  });

  it("returns library items only when ?tier=library", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=library&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { tier: "library" | "feed" } }[];
    };
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.item.tier).toBe("library");
    }
  });

  it("returns feed items only when ?tier=feed", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=feed&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { tier: "library" | "feed" } }[];
    };
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.item.tier).toBe("feed");
    }
  });

  it("treats ?tier=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=all&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { tier: "library" | "feed" } }[];
    };
    const libraryFlags = new Set(data.results.map((r) => r.item.tier));
    expect(libraryFlags.has("library")).toBe(true);
    expect(libraryFlags.has("feed")).toBe(true);
  });
});

describe("GET /search?tags=", () => {
  const corpus = `tagged-corpus-${String(Math.random()).slice(2, 8)}`;

  beforeAll(async () => {
    // Three notes with overlapping tags.
    const make = async (tags: string[]) => {
      const itemRes = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        body: {
          type: "core.note",
          properties: { body: corpus },
          tags,
        },
      });
      return ((await itemRes.json()) as { item: { id: string } }).item.id;
    };
    await make(["red", "small"]);
    await make(["red", "large"]);
    await make(["blue", "small"]);
  });

  it("filters search results to items with a single tag", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${corpus}&tags=red&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { metadata: { tags: string[] } }[];
    };
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.metadata.tags).toContain("red");
    }
  });

  it("requires ALL tags when multiple are supplied (AND semantics)", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${corpus}&tags=red,small&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { metadata: { tags: string[] } }[];
    };
    for (const result of data.results) {
      expect(result.metadata.tags).toContain("red");
      expect(result.metadata.tags).toContain("small");
    }
    // Only the red+small note should match; not red+large or blue+small.
    expect(data.results.length).toBe(1);
  });

  it("returns empty when no items have the requested tag", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${corpus}&tags=nonexistent&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });
});
