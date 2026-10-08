/**
 * Every read surface that compiles a type filter, asked the same question by
 * the same credential.
 *
 * `computeTypeFilter` returns a grant and the exclusions that carve into it,
 * and **four compilers turn that into a predicate**, each over the shared
 * `typeFilterTerms`: `allowedTypesCondition` in the item store, which its
 * listing and `stats` share; the search store's own clause; the metadata
 * store's clause for the tag vocabulary; and, not SQL at all,
 * `matchesTypeFilter` over the SSE stream. A negative term that reached some
 * of them and not the others would leave two surfaces disagreeing about one
 * grant.
 *
 * **The tag vocabulary is the sharp one and it is not obvious.** The
 * metadata store skips its type clause when the allow-list holds a global
 * wildcard and nothing is excluded beside it. A grant of
 * `{"*": "read", "<withheld>": "none"}` reaches that check carrying a
 * wildcard, so a skip keyed on the wildcard alone would compute the
 * vocabulary over every registered type, the withheld one included. Tag
 * names leak what exists even when no item behind them is readable.
 *
 * Every case names a type that must survive as well as one that must not: an
 * assertion that only checks the withheld type is absent passes on a surface
 * returning nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

const KEPT = "user.kept_note";
const WITHHELD = "user.withheld_note";
const KEPT_TAG = "kept-tag";
const WITHHELD_TAG = "withheld-tag";

let ctx: TestContext;
const itemIds: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  const seed: [string, string][] = [
    [KEPT, KEPT_TAG],
    [WITHHELD, WITHHELD_TAG],
  ];
  for (const [id, tag] of seed) {
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id, version: 1, fields: { title: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: id,
        properties: { title: `zqxbrindle ${id}` },
        tags: [tag],
      },
    });
    expect(created.status).toBe(201);
    itemIds[id] = ((await created.json()) as { item: { id: string } }).item.id;
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * A key whose reach is exactly its permission map — nothing reads past it.

 */
async function mintKey(type_permissions: Perms): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);

  const raw = await mintWorkingKey(ctx, {
    permissions: [],
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    label: `excl-${suffix}`,
    source: `excl-${suffix}`,
    type_permissions,
    default_tier: "library",
  });
  return raw;
}

async function listedTypes(key: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", "/items?limit=100", { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { type: string }[] };
  return body.data.map((i) => i.type);
}

async function searchedTypes(key: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", "/search?q=zqxbrindle", { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { item: { type: string } }[];
  };
  return body.data.map((r) => r.item.type);
}

async function tagVocabulary(key: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", "/metadata/tags", { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { tag: string }[] };
  return body.data.map((t) => t.tag);
}

async function statsTypes(key: string): Promise<Record<string, number>> {
  const res = await request(ctx.app, "GET", "/items/stats", { key });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
}

/**
 * The single-id point check, as a boolean. `GET /items/{id}` runs
 * `requireTypeAccess` and refuses outright, where a list read narrows
 * silently — implicit denial is the documented answer there, so a list
 * request is not the point check and asking it would prove nothing.
 */
async function pointCheckAdmits(key: string, type: string): Promise<boolean> {
  const id = itemIds[type];
  // `beforeAll` seeds both types, so a missing id is a broken fixture rather
  // than a case worth tolerating.
  expect(id).toBeDefined();
  const res = await request(ctx.app, "GET", `/items/${String(id)}`, { key });
  return res.status === 200;
}

type Perms = Record<string, "read" | "write" | "none">;

const WILDCARD_SHAPES: { label: string; perms: Perms }[] = [
  {
    label: "a global wildcard with an exact exclusion",
    perms: { "*": "read", [WITHHELD]: "none" },
  },
  {
    label: "a subtree wildcard with an exclusion nested beneath it",
    perms: { "user.*": "read", [WITHHELD]: "none" },
  },
];

describe.each(WILDCARD_SHAPES)(
  "every read surface honors $label",
  ({ perms }) => {
    it("GET /items lists the granted type and not the withheld one", async () => {
      const key = await mintKey(perms);
      const types = await listedTypes(key);
      expect(types).toContain(KEPT);
      expect(types).not.toContain(WITHHELD);
    });

    it("GET /search returns the granted type and not the withheld one", async () => {
      const key = await mintKey(perms);
      const types = await searchedTypes(key);
      expect(types).toContain(KEPT);
      expect(types).not.toContain(WITHHELD);
    });

    it("GET /items/stats counts the granted type and not the withheld one", async () => {
      const key = await mintKey(perms);
      // `stats` groups by state, so the assertion is on the total: one row is
      // readable and one is not.
      const granted = await statsTypes(await mintKey({ "user.*": "read" }));
      const narrowed = await statsTypes(key);
      const total = (s: Record<string, number>): number =>
        Object.values(s).reduce((a, b) => a + b, 0);
      expect(total(granted)).toBe(2);
      expect(total(narrowed)).toBe(1);
    });

    it("GET /metadata/tags omits the withheld type's tag from the vocabulary", async () => {
      // The metadata short-circuit. Under the global-wildcard case this is
      // the assertion that reddens if `includes("*")` skips the clause again.
      const key = await mintKey(perms);
      const tags = await tagVocabulary(key);
      expect(tags).toContain(KEPT_TAG);
      expect(tags).not.toContain(WITHHELD_TAG);
    });

    it("agrees with the point check on both types", async () => {
      const key = await mintKey(perms);
      // Both directions. Only asserting the refusal would pass on a filter
      // that withheld everything.
      expect(await pointCheckAdmits(key, WITHHELD)).toBe(false);
      expect(await pointCheckAdmits(key, KEPT)).toBe(true);
    });
  },
);

describe("an exact grant outranks a wildcard exclusion spanning it", () => {
  // The case a naive "every exclusion subtracts from every grant" gets
  // backwards, asserted through SQL rather than only through the resolver.
  const perms: Perms = {
    [WITHHELD]: "read",
    "user.*": "none",
  };

  it("lists the exactly-granted type and nothing else under the subtree", async () => {
    const key = await mintKey(perms);
    const types = await listedTypes(key);
    expect(types).toContain(WITHHELD);
    expect(types).not.toContain(KEPT);
  });

  it("keeps its tag in the vocabulary", async () => {
    const key = await mintKey(perms);
    const tags = await tagVocabulary(key);
    expect(tags).toContain(WITHHELD_TAG);
    expect(tags).not.toContain(KEPT_TAG);
  });
});
