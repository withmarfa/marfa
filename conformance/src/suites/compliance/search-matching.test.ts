import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import {
  MATCHING_CASES,
  MATCHING_FIELDS,
  MATCHING_ROWS,
  MARKUP_QUERY,
  MARKUP_SNIPPET,
  SNIPPET_QUERY,
} from "../../utils/search-matching.js";

/**
 * How a query is read, which words and fields it matches, and how the hits
 * are ordered and excerpted: `search-and-filters/search-stem` to `search-and-filters/excerpt-markup`. The device
 * holds itself to the same cases in `device/search-live.test.ts`.
 */

let client: MarfaClient;
let ctx: TestContext;
let typeId: string;
const ids = new Map<string, string>();

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "search-matching"));
  typeId = `user.matching-${ctx.runId}`;
  const registered = await client.registerType({
    id: typeId,
    fields: { ...MATCHING_FIELDS },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  for (const row of MATCHING_ROWS) {
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      tier: "library",
      properties: row.properties,
      tags: row.tags,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    trackItem(ctx, created.data.item.id);
    ids.set(row.key, created.data.item.id);
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

function id(key: string): string {
  const found = ids.get(key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

/** The answer a case expects, in its order: a group's rows by identifier. */
function expected(groups: string[][]): string[] {
  return groups.flatMap((group) => group.map(id).sort());
}

describe("search matching", () => {
  it.each(MATCHING_CASES)("$name: $query", async (testCase) => {
    const result = await client.search(testCase.query, {
      type: typeId,
      limit: 50,
    });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const got = result.data.data.map((hit) => hit.item.id);
    if (testCase.ranked) expect(got).toEqual(expected(testCase.hits));
    else expect([...got].sort()).toEqual(expected(testCase.hits).sort());
  });

  it("scores a hit by its rank and gives the better hit the higher score", async () => {
    const result = await client.search("kiwi", { type: typeId, limit: 50 });
    expect(result.ok).toBe(true);
    const scores = result.data.data.map((hit) => hit.relevance_score);
    expect(scores.length).toBeGreaterThan(2);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBe(scores[3]);
    for (const score of scores) expect(score).toBeGreaterThan(0);
  });

  it("excerpts a match in a long text, marked and cut", async () => {
    const result = await client.search(SNIPPET_QUERY, {
      type: typeId,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    const hit = result.data.data.find((entry) => entry.item.id === id("long"));
    expect(hit?.snippet_html).toContain("<mark>needle</mark>");
    expect(hit?.snippet_html?.startsWith("...")).toBe(true);
    const words = (hit?.snippet_html ?? "")
      .replace(/<\/?mark>/g, "")
      .split(/\s+/)
      .filter((word) => word !== "..." && word !== "");
    expect(words.length).toBeLessThanOrEqual(32);
  });

  it("marks the match in the column that holds it, not only in the title", async () => {
    const result = await client.search("landscape", {
      type: typeId,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    const hit = result.data.data.find((entry) => entry.item.id === id("marsh"));
    expect(hit?.snippet_html).toBe("A quiet <mark>landscape</mark>");
  });

  it("escapes the row's text in an excerpt and marks only the match", async () => {
    const result = await client.search(MARKUP_QUERY, {
      type: typeId,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(
      result.data.data.map((entry) => [entry.item.id, entry.snippet_html]),
    ).toEqual([[id("markup"), MARKUP_SNIPPET]]);
  });
});

describe("how a query is folded and split", () => {
  let foldingType: string;
  const rows = new Map<string, string>();

  beforeAll(async () => {
    foldingType = `user.folding-${ctx.runId}`;
    const registered = await client.registerType({
      id: foldingType,
      fields: { body: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    for (const [key, body] of [
      ["upper", "QUOKKA"],
      ["lower", "quokka"],
      ["accented", "caf\u00e9"],
      ["plain", "cafe"],
      ["umlaut", "Z\u00fcrich"],
      ["joined", "abc123 def"],
      ["split", "abc 123"],
      ["hyphen", "x-ray"],
      ["underscore", "snake_case"],
    ] as const) {
      const created = await client.createItem({
        type: foldingType,
        source: ctx.source,
        properties: { body },
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
      rows.set(key, created.data.item.id);
    }
  });

  async function found(query: string): Promise<string[]> {
    const result = await client.search(query, {
      type: foldingType,
      limit: 50,
    });
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    const byId = new Map([...rows].map(([key, rowId]) => [rowId, key]));
    return result.data.data.map((hit) => byId.get(hit.item.id) ?? "?").sort();
  }

  it("folds case in the text and in the query", async () => {
    // The witness: a word spelled as a row spells it finds that row, so the
    // other spellings are the folding's.
    for (const query of ["quokka", "QUOKKA", "QuOkKa"]) {
      expect(await found(query), query).toEqual(["lower", "upper"]);
    }
  });

  it("folds diacritics in the text and in the query", async () => {
    for (const query of ["cafe", "caf\u00e9", "CAF\u00c9"]) {
      expect(await found(query), query).toEqual(["accented", "plain"]);
    }
    for (const query of ["zurich", "Z\u00dcRICH", "z\u00fcrich"]) {
      expect(await found(query), query).toEqual(["umlaut"]);
    }
  });

  it("splits words at anything that is not a letter or a digit, and keeps a digit inside its word", async () => {
    // A run of letters and digits is one word, so `abc123` is not `abc`
    // followed by `123`.
    expect(await found("abc123")).toEqual(["joined"]);
    expect(await found("abc 123")).toEqual(["split"]);
    expect(await found("123")).toEqual(["split"]);
    // A hyphen and an underscore end a word.
    expect(await found("ray")).toEqual(["hyphen"]);
    expect(await found("x ray")).toEqual(["hyphen"]);
    expect(await found("case")).toEqual(["underscore"]);
    expect(await found("snake case")).toEqual(["underscore"]);
    expect(await found("snakecase")).toEqual([]);
  });

  it("matches nothing, without an error, for a query with no word in it", async () => {
    // The witness: a word the rows hold is found, so the empty answers below
    // are the query's and not an empty type.
    expect(await found("quokka")).toHaveLength(2);
    for (const query of ["!!!", '""', "*", "---", "()", '" "', "\u2014"]) {
      expect(await found(query), query).toEqual([]);
    }
  });
});
