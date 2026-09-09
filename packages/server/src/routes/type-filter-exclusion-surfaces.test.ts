/**
 * Every read surface that compiles a type filter, asked the same question by
 * the same credential.
 *
 * `computeTypeFilter` returns a grant and the exclusions that carve into it,
 * and **seven separate compilers turn that into a predicate**: the shared
 * `allowedTypesCondition` in both item stores, `stats` in both, an inlined
 * decomposition in both search stores, a third variant in both metadata
 * stores for the tag vocabulary, and — not SQL at all — `matchesTypeFilter`
 * over the SSE stream. A negative term that reached six of them and not the
 * seventh would leave two surfaces disagreeing about one grant, which is the
 * defect this whole change exists to close, reintroduced one layer down.
 *
 * **The tag vocabulary is the sharp one and it is not obvious.** Both
 * metadata stores skip their type clause entirely when the allow-list holds
 * a global wildcard. That was safe only while `computeTypeFilter` enumerated
 * the wildcard into concrete ids before it arrived; the moment it stopped, a
 * grant of `{"*": "read", "<withheld>": "none"}` reaches the skip carrying a
 * wildcard, and the vocabulary is computed over every type in the space
 * including the withheld one. Tag names leak what exists even when no item
 * behind them is readable.
 *
 * Every case names a type that must survive as well as one that must not: an
 * assertion that only checks the withheld type is absent passes on a surface
 * returning nothing at all.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

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
      key: ctx.spaceKey,
      body: { id, version: 1, fields: { title: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
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
 *
 * `is_operator` is set because this context is keys mode, where no key
 * carries a space and the schema requires a space-less key to be an operator
 * key. It buys nothing here: the operator flag fences off the instance tier
 * and the reserved namespaces, and `checkTypeAccess` still consults the map
 * for everything else, which is the whole subject of this file.
 */
async function mintKey(type_permissions: Perms): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_excl_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `excl-${suffix}`,
      source: `excl-${suffix}`,
      type_permissions,
      default_tier: "library",
      is_operator: true,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
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
    results: { item: { type: string } }[];
  };
  return body.results.map((r) => r.item.type);
}

async function tagVocabulary(key: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", "/metadata/tags", { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tags: { tag: string }[] };
  return body.tags.map((t) => t.tag);
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
