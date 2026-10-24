import { describe, expect, it } from "vitest";
import { rewriteTypeTerms } from "./query-parser.js";

describe("rewriteTypeTerms", () => {
  it("rewrites an eq and a neq naming the type, and keeps every other byte", () => {
    expect(
      rewriteTypeTerms(
        'type eq "acme.deal"  AND properties.stage neq "lost" AND type neq "acme.deal"',
        "acme.deal",
        "acme.contract",
      ),
    ).toEqual({
      filter:
        'type eq "acme.contract"  AND properties.stage neq "lost" AND type neq "acme.contract"',
      rewritten: true,
      unsafe: [],
    });
  });

  it("leaves a filter that does not name the type as it is", () => {
    expect(
      rewriteTypeTerms(
        'type eq "acme.other" OR properties.type eq "acme.deal"',
        "acme.deal",
        "acme.contract",
      ),
    ).toEqual({
      filter: 'type eq "acme.other" OR properties.type eq "acme.deal"',
      rewritten: false,
      unsafe: [],
    });
  });

  it("names a term whose answer the move would change and that it cannot rewrite", () => {
    expect(
      rewriteTypeTerms(
        'type starts_with "acme.d" AND type neq "acme.contract"',
        "acme.deal",
        "acme.contract",
      ).unsafe,
    ).toEqual(['type starts_with "acme.d"', 'type neq "acme.contract"']);
  });

  it("leaves a term the move does not change the answer of", () => {
    expect(
      rewriteTypeTerms(
        'type starts_with "acme."',
        "acme.deal",
        "acme.contract",
      ),
    ).toEqual({
      filter: 'type starts_with "acme."',
      rewritten: false,
      unsafe: [],
    });
  });

  it("answers a filter that doesn't parse as unreadable, without throwing", () => {
    expect(
      rewriteTypeTerms(
        'type eq "acme.deal" AND (',
        "acme.deal",
        "acme.contract",
      ),
    ).toEqual({
      filter: 'type eq "acme.deal" AND (',
      rewritten: false,
      unsafe: [],
      unreadable: "filter",
    });
  });

  it("answers a rewrite that would be over the length limit as unreadable", () => {
    const filter = `type eq "acme.deal" OR properties.title eq "${"x".repeat(2000)}"`;
    expect(filter.length).toBeLessThanOrEqual(2048);
    expect(
      rewriteTypeTerms(filter, "acme.deal", "acme.contractwithalongername"),
    ).toEqual({ filter, rewritten: false, unsafe: [], unreadable: "rewrite" });
  });
});
