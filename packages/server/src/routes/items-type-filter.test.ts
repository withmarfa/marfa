/**
 * The `?type=` read filter and the type predicates it compiles to.
 *
 * Three separate contracts meet on this query parameter and each one has
 * bitten before:
 *
 *  - A bare identifier and its subtree wildcard name the same set, so every
 *    gate keyed off the parameter has to treat them the same. A gate that
 *    only recognizes the bare form is off by one query string.
 *  - Type identifiers may contain `_`, which is a single-character wildcard
 *    in SQL `LIKE`. Unescaped, a subtree predicate for `demo.web_gallery`
 *    also admits `demo.webxgallery`.
 *  - The parameter is caller-supplied, so it must be validated against the
 *    pattern grammar before it reaches a predicate at all.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

// Two identifiers that differ only where `LIKE` would treat `_` as a
// wildcard, plus a child of the underscored one so the subtree half of the
// predicate has something legitimate to match.
const UNDERSCORE_PARENT = "demo.web_gallery";
const UNDERSCORE_CHILD = "demo.web_gallery.card";
const LOOKALIKE = "demo.webxgallery";
const LOOKALIKE_CHILD = "demo.webxgallery.card";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  for (const id of [
    UNDERSCORE_PARENT,
    UNDERSCORE_CHILD,
    LOOKALIKE,
    LOOKALIKE_CHILD,
  ]) {
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id, version: 1, fields: { title: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: id, properties: { title: id } },
    });
    expect(created.status).toBe(201);
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

async function listTypes(query: string, key: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", query, { key });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { type: string }[] };
  return body.data.map((item) => item.type).sort();
}

/**
 * Mint a key whose only readable types are `patterns`.
 *
 * Bound to the context's space, which is what an ordinary working credential
 * is: the type map is the whole of what this key can read.
 */
async function mintScopedKey(
  patterns: Record<string, "read" | "write">,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_scoped_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `scoped-${suffix}`,
      source: `scoped-${suffix}`,
      type_permissions: patterns,
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    ctx.spaceId,
  );
  return raw;
}

describe("GET /items?type= — underscores are literal identifier bytes", () => {
  it("does not admit a lookalike sibling for a bare identifier", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}`, ctx.spaceKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });

  it("does not admit a lookalike sibling for a subtree wildcard", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}.*`, ctx.spaceKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });
});

describe("GET /items?type= — pattern grammar", () => {
  it("rejects a LIKE metacharacter smuggled in as a subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=%25.*", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an underscore-only wildcard root", async () => {
    const res = await request(ctx.app, "GET", "/items?type=_.*", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=demo..thing.*", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("still rejects a bare invalid identifier", async () => {
    const res = await request(ctx.app, "GET", "/items?type=NotAType", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });
});

describe("allowed_types — underscore handling across read surfaces", () => {
  it("scopes /search to the literal subtree", async () => {
    const key = await mintScopedKey({ [`${UNDERSCORE_PARENT}.*`]: "read" });
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${encodeURIComponent("gallery")}`,
      { key },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { item: { type: string } }[];
    };
    const types = [...new Set(body.results.map((r) => r.item.type))].sort();
    expect(types).not.toContain(LOOKALIKE);
    expect(types).not.toContain(LOOKALIKE_CHILD);
  });

  it("scopes /metadata/tags to the literal subtree", async () => {
    // Tag one item per type so a leaked type shows up as a leaked tag.
    for (const [id, tag] of [
      [UNDERSCORE_CHILD, "tag-underscored"],
      [LOOKALIKE_CHILD, "tag-lookalike"],
    ] as const) {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: { type: id, properties: { title: id }, tags: [tag] },
      });
      expect(created.status).toBe(201);
    }

    const key = await mintScopedKey({ [`${UNDERSCORE_PARENT}.*`]: "read" });
    const res = await request(ctx.app, "GET", "/metadata/tags", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: { tag: string }[] };
    const tags = body.tags.map((t) => t.tag);
    expect(tags).toContain("tag-underscored");
    expect(tags).not.toContain("tag-lookalike");
  });

  it("returns no tags to a credential with no readable types", async () => {
    // An empty allow-list means "nothing is readable", and every other read
    // surface says so. The tag aggregate guarded on a non-empty list, so the
    // empty case skipped the type clause and handed back the space's whole
    // vocabulary with counts — which names what exists even though no item
    // behind it is readable.
    const key = await mintScopedKey({});

    const tagsRes = await request(ctx.app, "GET", "/metadata/tags", { key });
    expect(tagsRes.status).toBe(200);
    const tagsBody = (await tagsRes.json()) as { tags: { tag: string }[] };
    expect(tagsBody.tags).toEqual([]);

    // The sibling surfaces, pinned in the same test so a future divergence
    // reads as the disagreement it is.
    expect(await listTypes("/items", key)).toEqual([]);
    const statsRes = await request(ctx.app, "GET", "/items/stats", { key });
    expect(statsRes.status).toBe(200);
    expect(await statsRes.json()).toEqual({});
  });
});

describe("GET /items?filter= — LIKE operands declare their escape character", () => {
  it("treats an underscore in a contains filter as a literal", async () => {
    // `escapeLike` writes `\_`, but a LIKE has no default escape character:
    // unaccompanied by an ESCAPE clause the pattern means "backslash, then
    // any character", and this query returns nothing.
    const types = await listTypes(
      `/items?filter=${encodeURIComponent('type contains "web_gallery"')}`,
      ctx.spaceKey,
    );
    expect(types).toContain(UNDERSCORE_PARENT);
    expect(types).not.toContain(LOOKALIKE);
    expect(types).not.toContain(LOOKALIKE_CHILD);
  });
});

describe("GET /items/stats — counts what the caller can actually read", () => {
  async function statsTotal(key: string): Promise<number> {
    const res = await request(ctx.app, "GET", "/items/stats", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    return Object.values(body).reduce((sum, n) => sum + n, 0);
  }

  it("counts the subtree a wildcard-scoped credential can read", async () => {
    // The patterns reach here verbatim, so comparing them as literal
    // identifiers found no type named `demo.web_gallery.*` and reported zero.
    const key = await mintScopedKey({ [`${UNDERSCORE_PARENT}.*`]: "read" });
    expect(await statsTotal(key)).toBeGreaterThan(0);
  });

  it("counts everything for a globally-scoped credential", async () => {
    const key = await mintScopedKey({ "*": "read" });
    expect(await statsTotal(key)).toBeGreaterThan(0);
  });

  it("counts nothing for a credential with no readable types", async () => {
    // The list path already forces zero rows on an empty filter; stats used to
    // skip the clause entirely and report the whole space.
    const key = await mintScopedKey({});
    expect(await statsTotal(key)).toBe(0);
  });
});

describe("DELETE /types/:id — in-use check", () => {
  it("does not count a lookalike sibling's items as in-use", async () => {
    // `demo.solo_type` has no items of its own; `demo.soloxtype.child` does.
    // An unescaped `LIKE 'demo.solo_type.%'` matches the latter and refuses
    // a delete that should succeed.
    for (const id of ["demo.solo_type", "demo.soloxtype.child"]) {
      const registered = await request(ctx.app, "POST", "/types", {
        key: ctx.spaceKey,
        body: { id, version: 1, fields: { title: { type: "string" } } },
      });
      expect(registered.status).toBe(201);
    }
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "demo.soloxtype.child", properties: { title: "decoy" } },
    });
    expect(created.status).toBe(201);

    const res = await request(ctx.app, "DELETE", "/types/demo.solo_type", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
  });
});
