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
      key: ctx.adminKey,
      body: { id, version: 1, fields: { title: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
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

/** Mint a member-tier key whose only readable types are `patterns`. */
async function mintScopedKey(
  patterns: Record<string, "read" | "write">,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_scoped_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `scoped-${suffix}`,
      source: `scoped-${suffix}`,
      role: "member",
      type_permissions: patterns,
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

describe("GET /items?type= — underscores are literal identifier bytes", () => {
  it("does not admit a lookalike sibling for a bare identifier", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}`, ctx.adminKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });

  it("does not admit a lookalike sibling for a subtree wildcard", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}.*`, ctx.adminKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });
});

describe("GET /items?type= — pattern grammar", () => {
  it("rejects a LIKE metacharacter smuggled in as a subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=%25.*", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an underscore-only wildcard root", async () => {
    const res = await request(ctx.app, "GET", "/items?type=_.*", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=demo..thing.*", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("still rejects a bare invalid identifier", async () => {
    const res = await request(ctx.app, "GET", "/items?type=NotAType", {
      key: ctx.adminKey,
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
        key: ctx.adminKey,
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
});

describe("DELETE /types/:id — in-use check", () => {
  it("does not count a lookalike sibling's items as in-use", async () => {
    // `demo.solo_type` has no items of its own; `demo.soloxtype.child` does.
    // An unescaped `LIKE 'demo.solo_type.%'` matches the latter and refuses
    // a delete that should succeed.
    for (const id of ["demo.solo_type", "demo.soloxtype.child"]) {
      const registered = await request(ctx.app, "POST", "/types", {
        key: ctx.adminKey,
        body: { id, version: 1, fields: { title: { type: "string" } } },
      });
      expect(registered.status).toBe(201);
    }
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "demo.soloxtype.child", properties: { title: "decoy" } },
    });
    expect(created.status).toBe(201);

    const res = await request(ctx.app, "DELETE", "/types/demo.solo_type", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
  });
});
