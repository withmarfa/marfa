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
 * are ordered and excerpted: `search-and-filters.md` 42 to 49 and 87. The device
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
