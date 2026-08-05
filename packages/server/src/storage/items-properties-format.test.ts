import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

const isPg = (): boolean => (process.env.DB_DIALECT ?? "sqlite") === "pg";

const id = (suffix: string): string =>
  `019d0000-0000-7000-a000-${suffix.padStart(12, "0")}`;

/**
 * Properties chosen to stress the structured round trip: unicode outside the
 * BMP, JSON escapes, deep nesting, arrays with mixed members, numbers at
 * float precision edges, explicit nulls inside containers, and empty
 * containers. Object-level equivalence is the contract; key order is not.
 */
const gnarly: Record<string, unknown> = {
  title: 'Ünïcode \u{1F30D} — quotes " and \\ backslash',
  body: "line one\nline two\ttabbed",
  nested: { a: { b: { c: [1, 2, { d: "deep" }] } } },
  arr: [true, false, 0, 1.5, "x", { y: [] }],
  big: 9007199254740991,
  small: 1e-10,
  frac: 0.1,
  nul_in_arr: [null, "after-null"],
  empty_obj: {},
  empty_arr: [],
};

async function storedTypeOf(itemId: string): Promise<string> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    const rows = (await s.__pgClient(
      "SELECT pg_typeof(properties)::text AS t FROM items WHERE id = $1",
      [itemId],
    )) as { t: string }[];
    return rows[0]?.t ?? "missing";
  }
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await s.__sqliteAll(
    `SELECT typeof(properties) AS t FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { t: string }[];
  return rows[0]?.t ?? "missing";
}

describe("items.properties is stored natively structured", () => {
  it("create writes the database's structured type, not text", async () => {
    const itemId = id("1");
    await ctx.storage.items.create(
      { id: itemId, type: "core.note", properties: gnarly, tier: "library" },
      undefined,
    );
    expect(await storedTypeOf(itemId)).toBe(isPg() ? "jsonb" : "blob");
  });

  it("round-trips gnarly properties object-equivalently through create and get", async () => {
    const itemId = id("2");
    await ctx.storage.items.create(
      { id: itemId, type: "core.note", properties: gnarly, tier: "library" },
      undefined,
    );
    const item = await ctx.storage.items.get(itemId);
    expect(item?.properties).toEqual(gnarly);
  });

  it("update keeps the structured encoding and the merged object", async () => {
    const itemId = id("3");
    await ctx.storage.items.create(
      { id: itemId, type: "core.note", properties: gnarly, tier: "library" },
      undefined,
    );
    const updated = await ctx.storage.items.update(itemId, {
      properties: { title: "replaced", added: [1, 2, 3] },
    });
    expect("error" in updated).toBe(false);
    expect(await storedTypeOf(itemId)).toBe(isPg() ? "jsonb" : "blob");
    const item = await ctx.storage.items.get(itemId);
    expect(item?.properties.title).toBe("replaced");
    expect(item?.properties.added).toEqual([1, 2, 3]);
    expect(item?.properties.nested).toEqual(gnarly.nested);
  });

  it("the in-place last_used_at stamp preserves the structured encoding", async () => {
    // The oauth store patches properties in SQL rather than through the item
    // store; on sqlite a json_set here would silently revert the row to text.
    const itemId = id("4");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { kind: "app", client_id: "c1", body: "grant" },
        tier: "library",
      },
      undefined,
    );
    await ctx.storage.oauth.updateLastUsedAt(itemId, null, 0);
    expect(await storedTypeOf(itemId)).toBe(isPg() ? "jsonb" : "blob");
    const item = await ctx.storage.items.get(itemId);
    expect(typeof item?.properties.last_used_at).toBe("string");
    expect(item?.properties.client_id).toBe("c1");
  });

  it("property filters read the structured column", async () => {
    const itemId = id("5");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { author: "Orwell", page_count: 328, body: "novel" },
        tier: "library",
      },
      undefined,
    );
    const byAuthor = await ctx.storage.items.list({
      filter: 'properties.author eq "Orwell"',
    });
    expect(byAuthor.data.some((i) => i.id === itemId)).toBe(true);
    const byCount = await ctx.storage.items.list({
      filter: "properties.page_count gt 300",
    });
    expect(byCount.data.some((i) => i.id === itemId)).toBe(true);
    const miss = await ctx.storage.items.list({
      filter: "properties.page_count gt 400",
    });
    expect(miss.data.some((i) => i.id === itemId)).toBe(false);
  });
});
