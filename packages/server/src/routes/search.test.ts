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
        library: true,
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `${sharedToken} ambient variant` },
        library: false,
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
      results: { item: { id: string; library: boolean } }[];
    };
    const libraryFlags = new Set(data.results.map((r) => r.item.library));
    expect(libraryFlags.has(true)).toBe(true);
    expect(libraryFlags.has(false)).toBe(true);
  });

  it("returns library items only when ?library=true", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&library=true&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { library: boolean } }[];
    };
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.item.library).toBe(true);
    }
  });

  it("returns ambient items only when ?library=false", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&library=false&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { library: boolean } }[];
    };
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.item.library).toBe(false);
    }
  });

  it("treats ?library=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&library=all&limit=100`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { item: { library: boolean } }[];
    };
    const libraryFlags = new Set(data.results.map((r) => r.item.library));
    expect(libraryFlags.has(true)).toBe(true);
    expect(libraryFlags.has(false)).toBe(true);
  });
});
