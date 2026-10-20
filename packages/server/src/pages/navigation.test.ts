import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  PAGE_SIZES,
  matchesQuery,
  paginate,
  parsePageNumber,
  parsePageSize,
  rankMatches,
  stepIndex,
} from "./navigation.js";

describe("stepIndex", () => {
  it("moves down and up, wrapping at both ends", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, -1, 3)).toBe(1);
  });

  it("starts at the first item going down and the last going up from nowhere", () => {
    expect(stepIndex(-1, 1, 4)).toBe(0);
    expect(stepIndex(-1, -1, 4)).toBe(3);
  });

  it("answers nowhere for an empty list", () => {
    expect(stepIndex(-1, 1, 0)).toBe(-1);
    expect(stepIndex(0, -1, 0)).toBe(-1);
  });
});

describe("matchesQuery", () => {
  it("matches every word, in any order, ignoring case", () => {
    expect(matchesQuery("keys api", "API keys Let scripts use Marfa")).toBe(
      true,
    );
    expect(matchesQuery("KEYS", "api keys")).toBe(true);
    expect(matchesQuery("keys trash", "api keys")).toBe(false);
  });

  it("matches everything for a blank query", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", "anything")).toBe(true);
  });

  it("treats the query as text, never as a pattern", () => {
    expect(matchesQuery("(", "a (b)")).toBe(true);
    expect(matchesQuery(".*", "abc")).toBe(false);
  });
});

describe("rankMatches", () => {
  const items = [
    { title: "Export and restore", haystack: "export and restore keys backup" },
    { title: "API keys", haystack: "api keys let scripts use marfa" },
    { title: "Browsers", haystack: "browsers where you are signed in" },
  ];

  it("returns the matching indexes with title matches first", () => {
    expect(rankMatches("keys", items)).toEqual([1, 0]);
  });

  it("keeps the given order among equal matches", () => {
    expect(rankMatches("e", items)).toEqual([0, 1, 2]);
  });

  it("returns nothing when nothing matches", () => {
    expect(rankMatches("zzz", items)).toEqual([]);
  });

  it("returns every index for a blank query", () => {
    expect(rankMatches("", items)).toEqual([0, 1, 2]);
  });
});

describe("paginate", () => {
  it("shows pages of ten rows", () => {
    expect(PAGE_SIZE).toBe(10);
    expect(paginate(42, 1)).toEqual({
      page: 1,
      size: 10,
      last: 5,
      from: 0,
      to: 10,
      total: 42,
      hasPrevious: false,
      hasNext: true,
    });
  });

  it("ends on a short page", () => {
    expect(paginate(42, 5)).toMatchObject({
      page: 5,
      from: 40,
      to: 42,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("holds a page past the end on the last page, and below one on the first", () => {
    expect(paginate(42, 99).page).toBe(5);
    expect(paginate(42, 0).page).toBe(1);
    expect(paginate(42, -3).page).toBe(1);
  });

  it("is one empty page for an empty list", () => {
    expect(paginate(0, 1)).toEqual({
      page: 1,
      size: 10,
      last: 1,
      from: 0,
      to: 0,
      total: 0,
      hasPrevious: false,
      hasNext: false,
    });
  });

  it("pages by the size it is given", () => {
    expect(paginate(42, 1, 25)).toMatchObject({
      size: 25,
      last: 2,
      from: 0,
      to: 25,
    });
    expect(paginate(42, 2, 25)).toMatchObject({ from: 25, to: 42 });
    expect(paginate(42, 1, 50)).toMatchObject({ last: 1, to: 42 });
  });

  it("fills exactly one page with ten rows", () => {
    expect(paginate(10, 1)).toMatchObject({ last: 1, to: 10, hasNext: false });
    expect(paginate(11, 1)).toMatchObject({ last: 2, hasNext: true });
  });
});

describe("parsePageNumber", () => {
  it("reads a positive whole number", () => {
    expect(parsePageNumber("3")).toBe(3);
  });

  it("falls back to the first page for anything else", () => {
    for (const bad of [undefined, "", "0", "-2", "1.5", "abc", "1e3", " 2"])
      expect(parsePageNumber(bad), String(bad)).toBe(1);
  });

  it("does not trust a number too large to count with", () => {
    expect(parsePageNumber("99999999999999999999")).toBe(1);
  });
});

describe("parsePageSize", () => {
  it("reads each size a list offers", () => {
    expect(PAGE_SIZES).toEqual([10, 25, 50]);
    for (const size of PAGE_SIZES)
      expect(parsePageSize(String(size))).toBe(size);
  });

  it("falls back to ten rows for anything else", () => {
    for (const bad of [
      undefined,
      "",
      "0",
      "-25",
      "5",
      "100",
      "25.0",
      "025",
      "abc",
      "1e1",
      " 25",
      "99999999999999999999",
    ])
      expect(parsePageSize(bad), String(bad)).toBe(10);
  });
});
