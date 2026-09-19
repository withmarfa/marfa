/**
 * The `source_filter` enforcement lever on list reads.
 *
 * `source_filter` narrows reads of the listed types to items written from an
 * approved source. The standard it has to meet is that no way of phrasing a
 * query reaches an unapproved row of a listed type: the lever is decided per
 * row, from the row's own type, so a bare listing, an ancestor wildcard and a
 * filter on some other axis all narrow identically. Keying it off `?type=`
 * instead made the control optional from the caller's side — the tests below
 * are the shapes that walked through it.
 *
 * The other half is that the lever stays per-type. A fix that narrowed the
 * whole result set would pass every test above and still be wrong, so an
 * unlisted type is pinned visible throughout.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { writeSpaceConfig } from "../storage/space-config.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;
let trustedKey: string;
let untrustedKey: string;

/**
 * Credentials stamp `source` onto every item they write, so "an item from an
 * untrusted source" means "an item written by a second credential".
 */
async function mintSpaceKey(source: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_src_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `source-filter-${source}`,
      source,
      permissions: [...SPACE_PERMISSIONS],
      // The rank this fixture carried admitted it past its own map, so the
      // map has to say what the rank granted silently.
      type_permissions: { "*": "write" },
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

beforeAll(async () => {
  ctx = await createTestContext({});
  trustedKey = await mintSpaceKey("trusted");
  untrustedKey = await mintSpaceKey("untrusted");

  for (const key of [trustedKey, untrustedKey]) {
    const created = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "note" } },
    });
    expect(created.status).toBe(201);
  }

  // An unlisted type from the same untrusted credential. The lever is
  // per-type, so this one stays visible however the query is spelled — a fix
  // that narrowed the whole result set instead of the listed type would hide
  // it and fail here.
  const unlisted = await request(ctx.app, "POST", "/items", {
    key: untrustedKey,
    body: { type: "core.bookmark", properties: { title: "bookmark" } },
  });
  expect(unlisted.status).toBe(201);

  await writeSpaceConfig(ctx.storage.settings, {
    enforcement: {
      source_filter: { types: ["core.note"], sources: ["trusted"] },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Distinct sources of the `core.note` rows a query returns. */
async function noteSources(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", query, { key: trustedKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { type: string; source: string }[];
  };
  return [
    ...new Set(
      body.data.filter((i) => i.type === "core.note").map((i) => i.source),
    ),
  ].sort();
}

/** Distinct types a query returns, so over-restriction is visible too. */
async function listTypes(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", query, { key: trustedKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { type: string }[] };
  return [...new Set(body.data.map((i) => i.type))].sort();
}

describe("source_filter applies to every spelling of the same type filter", () => {
  it("narrows a bare identifier to the approved sources", async () => {
    expect(await noteSources("/items?type=core.note")).toEqual(["trusted"]);
  });

  it("narrows the equivalent subtree wildcard to the approved sources", async () => {
    expect(await noteSources("/items?type=core.note.*")).toEqual(["trusted"]);
  });
});

describe("source_filter is not switchable off by broadening the query", () => {
  // Every one of these selects the filtered type's rows without naming it
  // exactly. Keying the lever off `?type=` meant a caller reached the
  // unapproved rows by asking for more, not less.
  it("narrows an ancestor wildcard", async () => {
    expect(await noteSources("/items?type=core.*")).toEqual(["trusted"]);
  });

  it("narrows a bare listing that names no type at all", async () => {
    expect(await noteSources("/items")).toEqual(["trusted"]);
  });

  it("narrows a tier-filtered listing", async () => {
    expect(await noteSources("/items?tier=library")).toEqual(["trusted"]);
  });

  it("narrows a state-filtered listing", async () => {
    expect(await noteSources("/items?state=active")).toEqual(["trusted"]);
  });

  it("narrows search", async () => {
    const res = await request(ctx.app, "GET", "/search?q=note", {
      key: trustedKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { item: { type: string; source: string } }[];
    };
    const sources = [
      ...new Set(
        body.results
          .filter((r) => r.item.type === "core.note")
          .map((r) => r.item.source),
      ),
    ].sort();
    expect(sources).toEqual(["trusted"]);
  });
});

describe("source_filter reaches the other list-shaped reads", () => {
  it("narrows the NDJSON export", async () => {
    // Otherwise the control is bypassable by swapping endpoint rather than
    // by rewording the query.
    const res = await request(ctx.app, "GET", "/export", { key: trustedKey });
    expect(res.status).toBe(200);
    const rows = (await res.text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as { item: { type: string; source: string } },
      );
    const sources = [
      ...new Set(
        rows
          .filter((r) => r.item.type === "core.note")
          .map((r) => r.item.source),
      ),
    ].sort();
    expect(sources).toEqual(["trusted"]);
    expect(rows.map((r) => r.item.type)).toContain("core.bookmark");
  });

  it("narrows the per-state counts", async () => {
    // Counts that disagree with the listing they summarize are their own
    // disclosure: they say how many rows the caller is not being shown.
    const res = await request(ctx.app, "GET", "/items/stats", {
      key: trustedKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    const total = Object.values(body).reduce((sum, n) => sum + n, 0);
    // Three rows exist: two `core.note` (one per source) and one unlisted
    // `core.bookmark`. The untrusted note is the only one the lever drops.
    expect(total).toBe(2);
    const listed = await request(ctx.app, "GET", "/items?limit=100", {
      key: trustedKey,
    });
    const listedBody = (await listed.json()) as { data: unknown[] };
    expect(total).toBe(listedBody.data.length);
  });
});

describe("source_filter leaves types it does not list alone", () => {
  it("keeps an unlisted type's untrusted rows on a bare listing", async () => {
    expect(await listTypes("/items")).toContain("core.bookmark");
  });

  it("keeps an unlisted type's untrusted rows when it is named directly", async () => {
    expect(await listTypes("/items?type=core.bookmark")).toEqual([
      "core.bookmark",
    ]);
  });
});
