/**
 * `?type=` means the same thing on every read surface.
 *
 * `/items` has always read the parameter as a subtree: the named type plus
 * everything under it, by name prefix and by declared parent. `/search`
 * read it as an exact identifier, and rejected the explicit wildcard
 * spelling outright. So the same narrowing applied to a listing and to a
 * search returned different sets, and the spelling that worked on one was
 * a 400 on the other.
 *
 * Two tests that each passed while describing different behavior is how
 * that survived, which is why this file asserts agreement rather than
 * per-endpoint behavior. Each case runs the same query through every read
 * surface and requires one answer.
 *
 * The resolved meaning is the subtree, because inheritance-inclusive reads
 * are the documented model everywhere else. That makes `/search` wider
 * than it was, which is a behavior change for a caller relying on it being
 * exact — hence the documentation companion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

/** Unique per run so parallel dialect runs cannot collide on type ids. */
const NS = `probe${Math.random().toString(36).slice(2, 8)}`;
const PARENT = `${NS}.parent`;
const NAMED_CHILD = `${NS}.parent.child`;
const DECLARED_CHILD = `${NS}.declared`;

/** A word that appears in every fixture body, so one search reaches them all. */
const NEEDLE = `${NS}needle`;

beforeAll(async () => {
  ctx = await createTestContext();

  const registerType = async (id: string, parent?: string): Promise<void> => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id,
        label: id,
        description: `Agreement fixture ${id}`,
        version: 1,
        ...(parent ? { parent } : {}),
        fields: { body: { type: "string", description: "Text" } },
        required: ["body"],
      },
    });
    expect(res.status).toBe(201);
  };

  await registerType(PARENT);
  // Under the parent by name, which is the prefix half of the subtree.
  await registerType(NAMED_CHILD, PARENT);
  // Under the parent by declaration only — its name shares no prefix, so it
  // is reachable through the registry or not at all. This is the half a
  // name-prefix LIKE cannot see.
  await registerType(DECLARED_CHILD, PARENT);

  for (const type of [PARENT, NAMED_CHILD, DECLARED_CHILD]) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type, properties: { body: `${NEEDLE} fixture for ${type}` } },
    });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

interface Surface {
  name: string;
  /** Every item type the surface returns for `?type=<type>`, sorted. */
  typesFor(type: string): Promise<{ status: number; types: string[] }>;
}

/**
 * The two surfaces nest the item differently — `/items` returns a flat
 * `data` array, `/search` wraps each hit under `results[].item`. Reading
 * the type out of both here is what lets the cases below compare the two
 * as sets rather than as response bodies.
 */
async function typesFrom(
  res: Response,
  pluck: (body: never) => { type: string }[],
): Promise<{ status: number; types: string[] }> {
  if (res.status !== 200) return { status: res.status, types: [] };
  const body = (await res.json()) as never;
  return {
    status: 200,
    types: [...new Set(pluck(body).map((i) => i.type))].sort(),
  };
}

const SURFACES: Surface[] = [
  {
    name: "GET /items",
    typesFor: async (type) =>
      typesFrom(
        await request(
          ctx.app,
          "GET",
          `/items?type=${encodeURIComponent(type)}&limit=100`,
          { key: ctx.adminKey },
        ),
        (b: never) => (b as { data: { type: string }[] }).data,
      ),
  },
  {
    name: "GET /search",
    typesFor: async (type) =>
      typesFrom(
        await request(
          ctx.app,
          "GET",
          `/search?q=${NEEDLE}&type=${encodeURIComponent(type)}&limit=100`,
          { key: ctx.adminKey },
        ),
        (b: never) =>
          (b as { results: { item: { type: string } }[] }).results.map(
            (r) => r.item,
          ),
      ),
  },
  {
    // The third read surface. It filters through the same item-store call
    // `/items` uses, so it already agreed on meaning — but it validated the
    // parameter as a bare identifier, so it disagreed on grammar.
    name: "GET /export",
    typesFor: async (type) => {
      const res = await request(
        ctx.app,
        "GET",
        `/export?type=${encodeURIComponent(type)}`,
        { key: ctx.adminKey },
      );
      if (res.status !== 200) return { status: res.status, types: [] };
      // NDJSON: one `{ item, metadata }` envelope per line.
      const types = (await res.text())
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { item?: { type?: string } })
        .map((o) => o.item?.type)
        .filter((t): t is string => typeof t === "string");
      return { status: 200, types: [...new Set(types)].sort() };
    },
  },
];

/** Non-null indexed access, so the strict-mode reads below stay honest. */
function at<T>(xs: T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`missing surface result ${String(i)}`);
  return x;
}

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describe("?type= resolves the same subtree on every read surface", () => {
  it("includes the named-prefix child", async () => {
    const results = await Promise.all(
      SURFACES.map(async (s) => ({
        name: s.name,
        ...(await s.typesFor(PARENT)),
      })),
    );
    for (const r of results) {
      expect(r.status, `${r.name} status`).toBe(200);
      expect(r.types, `${r.name} types`).toContain(PARENT);
      expect(r.types, `${r.name} types`).toContain(NAMED_CHILD);
    }
    // Agreement is the property, so compare the surfaces to each other and
    // not only each to an expectation. A future surface that resolves a
    // different-but-plausible set fails here even if every membership
    // assertion above still holds.
    for (const r of results.slice(1))
      expect(r.types, r.name).toEqual(at(results, 0).types);
  });

  it("includes the declared-parent child, whose name shares no prefix", async () => {
    const results = await Promise.all(
      SURFACES.map(async (s) => ({
        name: s.name,
        ...(await s.typesFor(PARENT)),
      })),
    );
    for (const r of results) {
      expect(r.types, `${r.name} types`).toContain(DECLARED_CHILD);
    }
    for (const r of results.slice(1))
      expect(r.types, r.name).toEqual(at(results, 0).types);
  });

  it("accepts the explicit wildcard spelling and reads it identically", async () => {
    const bare = await Promise.all(SURFACES.map((s) => s.typesFor(PARENT)));
    const wildcard = await Promise.all(
      SURFACES.map((s) => s.typesFor(`${PARENT}.*`)),
    );

    for (const [i, s] of SURFACES.entries()) {
      // The wildcard used to be a 400 on search and a subtree on items, so
      // assert the status too: a surface that starts rejecting it again
      // would otherwise pass on an empty-set comparison.
      expect(at(wildcard, i).status, `${s.name} wildcard status`).toBe(200);
      expect(at(wildcard, i).types, `${s.name} wildcard`).toEqual(
        at(bare, i).types,
      );
    }
    for (const w of wildcard.slice(1))
      expect(w.types).toEqual(at(wildcard, 0).types);
  });

  it("narrows to the leaf when the leaf is named", async () => {
    const results = await Promise.all(
      SURFACES.map(async (s) => ({
        name: s.name,
        ...(await s.typesFor(NAMED_CHILD)),
      })),
    );
    for (const r of results) {
      // A subtree read must still narrow. Resolving every ancestor's
      // siblings would pass the tests above while making the parameter
      // useless.
      expect(r.types, `${r.name} types`).toEqual([NAMED_CHILD]);
    }
  });

  it("rejects the global wildcard on every surface, with the same code", async () => {
    for (const s of SURFACES) {
      const { status } = await s.typesFor("*");
      expect(status, `${s.name} global wildcard`).toBe(400);
    }
  });
});
