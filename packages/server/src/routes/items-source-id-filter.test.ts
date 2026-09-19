/**
 * The folder query. A folder in this model is not a type and not an edge —
 * it is a prefix of the path a client stored the item under, so "everything
 * under Notes/" has to be expressible as a filter over `source_id`.
 *
 * The field was previously readable but not filterable, so the query the
 * folder model depends on could not be written at all, while the public
 * documentation described it as working.
 *
 * Runs on whichever dialect the suite is pointed at, because the predicate
 * is generated per dialect and the two have disagreed before.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

// A tree with two sibling folders, a nested level, and one path that differs
// from another only after the prefix boundary — `Notes` vs `Notesy` is the
// off-by-one a naive prefix match gets wrong.
const PATHS = [
  "Notes/first.md",
  "Notes/second.md",
  "Notes/2026/deep.md",
  "Notesy/decoy.md",
  "Archive/old.md",
  "top.md",
];

async function seed(path: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title: path, body: "x" },
      source_id: path,
    },
  });
  expect(res.status).toBe(201);
}

async function pathsMatching(filter: string): Promise<string[]> {
  const res = await request(
    ctx.app,
    "GET",
    `/items?filter=${encodeURIComponent(filter)}&limit=100`,
    { key: ctx.workingKey },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { source_id: string | null }[] };
  return body.data
    .map((i) => i.source_id)
    .filter((s): s is string => s !== null)
    .sort();
}

beforeAll(async () => {
  ctx = await createTestContext();
  for (const p of PATHS) await seed(p);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /items?filter= — source_id is filterable", () => {
  it("returns a folder's contents, nested levels included", async () => {
    expect(await pathsMatching('source_id starts_with "Notes/"')).toEqual([
      "Notes/2026/deep.md",
      "Notes/first.md",
      "Notes/second.md",
    ]);
  });

  it("stops at the prefix boundary rather than admitting a lookalike", async () => {
    // Without the trailing slash the sibling folder is a legitimate match;
    // this pins that the predicate compares the prefix and nothing else.
    expect(await pathsMatching('source_id starts_with "Notesy/"')).toEqual([
      "Notesy/decoy.md",
    ]);
  });

  it("addresses a nested folder directly", async () => {
    expect(await pathsMatching('source_id starts_with "Notes/2026/"')).toEqual([
      "Notes/2026/deep.md",
    ]);
  });

  it("matches an exact path", async () => {
    expect(await pathsMatching('source_id eq "top.md"')).toEqual(["top.md"]);
  });

  it("returns nothing for a folder that does not exist", async () => {
    expect(await pathsMatching('source_id starts_with "Nope/"')).toEqual([]);
  });

  it("treats a LIKE metacharacter in the prefix as a literal", async () => {
    // An unescaped `_` is a single-character wildcard, which would make this
    // silently match `Notes/` and hand back somebody else's folder.
    await seed("od_d/one.md");
    expect(await pathsMatching('source_id starts_with "od_d/"')).toEqual([
      "od_d/one.md",
    ]);
  });

  it("combines with a type filter", async () => {
    expect(
      await pathsMatching(
        'type eq "core.note" AND source_id starts_with "Archive/"',
      ),
    ).toEqual(["Archive/old.md"]);
  });

  it("matches regardless of case, on either dialect", async () => {
    // Paths carry human capitalization, and `notes/` for `Notes/` is
    // exactly the near-miss a person types. This pins the documented,
    // case-insensitive meaning.
    expect(await pathsMatching('source_id starts_with "notes/"')).toEqual([
      "Notes/2026/deep.md",
      "Notes/first.md",
      "Notes/second.md",
    ]);
    expect(await pathsMatching('source_id starts_with "NOTES/2026/"')).toEqual([
      "Notes/2026/deep.md",
    ]);
  });
});
