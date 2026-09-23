import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
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
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Quokkas of the world. Adorable creatures." },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/search?q=quokkas&type=core.note",
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: {
        item: { id: string; properties: Record<string, unknown> };
      }[];
    };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    expect(data.data[0]?.item.properties.body).toContain("Quokkas");
  });
});

describe("GET /search indexes tags", () => {
  it("finds an item by a tag that appears nowhere in its text, from the moment the tag is set", async () => {
    const tag = `wombatry${String(Date.now())}`;
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Nothing in this body names the tag." },
      },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    const before = await request(ctx.app, "GET", `/search?q=${tag}`, {
      key: ctx.workingKey,
    });
    expect(((await before.json()) as { data: unknown[] }).data).toEqual([]);

    const tagged = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.workingKey,
      body: { tags: [tag] },
    });
    expect(tagged.status).toBe(200);

    const found = await request(ctx.app, "GET", `/search?q=${tag}`, {
      key: ctx.workingKey,
    });
    expect(found.status).toBe(200);
    const results = (
      (await found.json()) as { data: { item: { id: string } }[] }
    ).data;
    expect(results.map((r) => r.item.id)).toEqual([item.id]);

    // And gone once the tag is: the index follows the sidecar both ways.
    const untagged = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/tags/${tag}`,
      { key: ctx.workingKey },
    );
    expect(untagged.status).toBe(200);
    const after = await request(ctx.app, "GET", `/search?q=${tag}`, {
      key: ctx.workingKey,
    });
    expect(((await after.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe("GET /search library filter", () => {
  // Use a unique whole-word token shared by both items so the FTS query
  // matches them directly. Tokenization is whitespace-based, so
  // substrings inside other words won't match — keep the token standalone.
  const sharedToken = `lib3query${String(Date.now())}`;

  beforeAll(async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: `${sharedToken} library variant` },
        tier: "library",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
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
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { item: { id: string; tier: "library" | "feed" } }[];
    };
    const libraryFlags = new Set(data.data.map((r) => r.item.tier));
    expect(libraryFlags.has("library")).toBe(true);
    expect(libraryFlags.has("feed")).toBe(true);
  });

  it("returns library items only when ?tier=library", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=library&limit=100`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { item: { tier: "library" | "feed" } }[];
    };
    expect(data.data.length).toBeGreaterThan(0);
    for (const result of data.data) {
      expect(result.item.tier).toBe("library");
    }
  });

  it("returns feed items only when ?tier=feed", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=feed&limit=100`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { item: { tier: "library" | "feed" } }[];
    };
    expect(data.data.length).toBeGreaterThan(0);
    for (const result of data.data) {
      expect(result.item.tier).toBe("feed");
    }
  });

  it("treats ?tier=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${sharedToken}&type=core.note&tier=all&limit=100`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { item: { tier: "library" | "feed" } }[];
    };
    const libraryFlags = new Set(data.data.map((r) => r.item.tier));
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
        key: ctx.workingKey,
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
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { metadata: { tags: string[] } }[];
    };
    expect(data.data.length).toBeGreaterThan(0);
    for (const result of data.data) {
      expect(result.metadata.tags).toContain("red");
    }
  });

  it("requires ALL tags when multiple are supplied (AND semantics)", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${corpus}&tags=red,small&limit=100`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { metadata: { tags: string[] } }[];
    };
    for (const result of data.data) {
      expect(result.metadata.tags).toContain("red");
      expect(result.metadata.tags).toContain("small");
    }
    // Only the red+small note should match; not red+large or blue+small.
    expect(data.data.length).toBe(1);
  });

  it("returns empty when no items have the requested tag", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${corpus}&tags=nonexistent&limit=100`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data).toHaveLength(0);
  });
});

/**
 * The one `include` token this route reads, which widens the row set rather
 * than hydrating anything. Untested here until now, and untested on `/items`
 * too — the conformance suite covers the default exclusion and the explicit
 * type filter and never the token itself.
 *
 * The case that asserts an absence pairs it with an ordinary row that must be
 * found, because a search asserting only the system row's absence passes
 * against an index that matched nothing at all. The type-filter case asserts a
 * presence only, and is right to.
 */
describe("GET /search?include=system", () => {
  // One standalone token per case. Tokenization is whitespace-based, so a
  // two-word marker searches as two terms and matches far more than intended.
  const token = (marker: string): string =>
    `sysinc${marker}${String(Date.now())}`;

  async function seedPair(
    word: string,
  ): Promise<{ noteId: string; deviceId: string }> {
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: `${word} note` },
      },
    });
    expect(note.status).toBe(201);
    const { item: n } = (await note.json()) as { item: { id: string } };
    // The reserved namespace is closed to every credential, so the platform's
    // own machinery writes a `system.*` row through the storage layer. The
    // store indexes it for search on the way in, which is all this pair needs
    // — the claim under test is what the read surface does with the row, not
    // how it got there.
    const device = await ctx.storage.items.create({
      type: "system.device",
      properties: { name: word, kind: "laptop" },
    });
    return { noteId: n.id, deviceId: device.id };
  }

  async function foundIds(query: string): Promise<string[]> {
    const res = await request(ctx.app, "GET", query, { key: ctx.workingKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { item: { id: string } }[] };
    return body.data.map((r) => r.item.id);
  }

  it("omits system.* rows when the token is absent", async () => {
    const word = token("absent");
    const { noteId, deviceId } = await seedPair(word);
    const ids = await foundIds(`/search?q=${word}`);
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
  });

  it("returns system.* rows when the token is present", async () => {
    const word = token("present");
    const { noteId, deviceId } = await seedPair(word);
    const ids = await foundIds(`/search?q=${word}&include=system`);
    expect(ids).toContain(noteId);
    expect(ids).toContain(deviceId);
  });

  it("opts in on a specific system.* type filter without the token", async () => {
    const word = token("bytype");
    const { deviceId } = await seedPair(word);
    const ids = await foundIds(`/search?q=${word}&type=system.device`);
    expect(ids).toContain(deviceId);
  });
});
