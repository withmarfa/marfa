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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

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
      key: ctx.workingKey,
      body: { id, version: 1, fields: { title: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
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
 * The type map is the whole of what this key can read, which is what an
 * ordinary working credential is.
 */
async function mintScopedKey(
  patterns: Record<string, "read" | "write">,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  let raw = `marfa_k1_scoped_${suffix}`;
  raw = await mintWorkingKey(ctx, {
    permissions: [],
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    label: `scoped-${suffix}`,
    source: `scoped-${suffix}`,
    type_permissions: patterns,
    default_tier: "library",
  });
  return raw;
}

describe("GET /items?type= — underscores are literal identifier bytes", () => {
  it("does not admit a lookalike sibling for a bare identifier", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}`, ctx.workingKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });

  it("does not admit a lookalike sibling for a subtree wildcard", async () => {
    expect(
      await listTypes(`/items?type=${UNDERSCORE_PARENT}.*`, ctx.workingKey),
    ).toEqual([UNDERSCORE_PARENT, UNDERSCORE_CHILD].sort());
  });
});

describe("GET /items?type= — pattern grammar", () => {
  it("rejects a LIKE metacharacter smuggled in as a subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=%25.*", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an underscore-only wildcard root", async () => {
    const res = await request(ctx.app, "GET", "/items?type=_.*", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed subtree wildcard", async () => {
    const res = await request(ctx.app, "GET", "/items?type=demo..thing.*", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("still rejects a bare invalid identifier", async () => {
    const res = await request(ctx.app, "GET", "/items?type=NotAType", {
      key: ctx.workingKey,
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
      data: { item: { type: string } }[];
    };
    const types = [...new Set(body.data.map((r) => r.item.type))].sort();
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
        key: ctx.workingKey,
        body: { type: id, properties: { title: id }, tags: [tag] },
      });
      expect(created.status).toBe(201);
    }

    const key = await mintScopedKey({ [`${UNDERSCORE_PARENT}.*`]: "read" });
    const res = await request(ctx.app, "GET", "/metadata/tags", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tag: string }[] };
    const tags = body.data.map((t) => t.tag);
    expect(tags).toContain("tag-underscored");
    expect(tags).not.toContain("tag-lookalike");
  });

  it("refuses every read surface to a credential with no readable types", async () => {
    // An empty allow-list is a credential that may read no type at all, and
    // the single-row doors have always refused it `type_not_permitted`.
    // These four answered `200` with an empty body, which says there is
    // nothing here rather than that this credential may not see it. All
    // four are pinned in one test so a future divergence reads as the
    // disagreement it is.
    const key = await mintScopedKey({});

    for (const path of [
      "/items",
      "/items/stats",
      "/metadata/tags",
      "/search?q=a",
    ]) {
      const res = await request(ctx.app, "GET", path, { key });
      expect(res.status, `${path} answered ${String(res.status)}`).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("type_not_permitted");
    }

    // The witness: a credential reaching one type reads all four, so what
    // closed is the reach and not the doors.
    const reader = await mintScopedKey({ "*": "read" });
    for (const path of [
      "/items",
      "/items/stats",
      "/metadata/tags",
      "/search?q=a",
    ]) {
      const res = await request(ctx.app, "GET", path, { key: reader });
      expect(res.status, `${path} refused a key that reaches a type`).toBe(200);
    }
  });
});

describe("GET /items?filter= — LIKE operands declare their escape character", () => {
  it("treats an underscore in a contains filter as a literal", async () => {
    // `escapeLike` writes `\_`, but a LIKE has no default escape character:
    // unaccompanied by an ESCAPE clause the pattern means "backslash, then
    // any character", and this query returns nothing.
    const types = await listTypes(
      `/items?filter=${encodeURIComponent('type contains "web_gallery"')}`,
      ctx.workingKey,
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

  it("refuses a credential with no readable types rather than counting zero", async () => {
    // Stats once skipped the type clause entirely and reported everything;
    // then it reported zero. Neither is the answer: a credential that may
    // read no type is refused, as it is on every sibling read.
    const key = await mintScopedKey({});
    const res = await request(ctx.app, "GET", "/items/stats", { key });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_not_permitted");

    // The witness, so the refusal is about the map and not about the door.
    const reader = await mintScopedKey({ "*": "read" });
    expect(await statsTotal(reader)).toBeGreaterThanOrEqual(0);
  });
});

describe("DELETE /types/:id — in-use check", () => {
  it("does not count a lookalike sibling's items as in-use", async () => {
    // `demo.solo_type` has no items of its own; `demo.soloxtype.child` does.
    // An unescaped `LIKE 'demo.solo_type.%'` matches the latter and refuses
    // a delete that should succeed.
    for (const id of ["demo.solo_type", "demo.soloxtype.child"]) {
      const registered = await request(ctx.app, "POST", "/types", {
        key: ctx.workingKey,
        body: { id, version: 1, fields: { title: { type: "string" } } },
      });
      expect(registered.status).toBe(201);
    }
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "demo.soloxtype.child", properties: { title: "decoy" } },
    });
    expect(created.status).toBe(201);

    const res = await request(ctx.app, "DELETE", "/types/demo.solo_type", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
  });
});
