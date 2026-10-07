import { describe, expect, it } from "vitest";
import {
  droppedCitations,
  expand,
  findSites,
  listIds,
  numberItems,
  outOfMap,
  replacement,
  rewrite,
  unchosen,
  type Migration,
} from "./spec-migration.js";

// The chapter is called `sample`, which no chapter is, and every backtick in
// a text below is escaped, so that no source file in the walk of
// `spec-citations.test.ts` cites a chapter that does not exist.

const migration: Migration = {
  "1": ["sample/a"],
  "2": ["sample/b", "sample/c"],
  "3": ["sample/d"],
  "4": ["sample/e"],
  "5": ["sample/f"],
  "6": ["sample/g"],
  "7": ["sample/h"],
};

const sitesIn = (text: string, file = "a.ts", own = false) =>
  findSites(file, text, "sample", migration, own);

/** The text each of a text's references becomes, with no choice made. */
const after = (text: string, file = "a.ts", own = false) =>
  rewrite(text, sitesIn(text, file, own));

describe("the numbers a reference lists", () => {
  it("reads a list, a range and a mixture", () => {
    expect(numberItems("3")).toEqual([{ from: 3, to: 3, range: false }]);
    expect(numberItems("1, 2 and 3")).toEqual([
      { from: 1, to: 1, range: false },
      { from: 2, to: 2, range: false },
      { from: 3, to: 3, range: false },
    ]);
    expect(numberItems("3, 5 to 8 and 10")).toEqual([
      { from: 3, to: 3, range: false },
      { from: 5, to: 8, range: true },
      { from: 10, to: 10, range: false },
    ]);
  });

  it("expands a range through the migration, once each ID", () => {
    expect(expand("3 to 5", migration)).toEqual({
      ids: ["sample/d", "sample/e", "sample/f"],
      unmapped: [],
      reasons: [],
    });
    expect(expand("3, 3 and 4", migration).ids).toEqual([
      "sample/d",
      "sample/e",
    ]);
  });

  it("says why a person has to choose", () => {
    expect(expand("2", migration).reasons).toEqual([
      "2 maps to 2 IDs, and which one is meant is a reading",
    ]);
    expect(expand("3 to 7", migration).reasons).toEqual([
      "3 to 7 expands to 5 IDs, more than 4",
    ]);
    expect(expand("3 to 6", migration).reasons).toEqual([]);
    expect(expand("99", migration)).toEqual({
      ids: [],
      unmapped: [99],
      reasons: ["99 is not in the migration"],
    });
  });

  it("writes IDs as a sentence lists them", () => {
    expect(listIds([])).toBe("");
    expect(listIds(["sample/a"])).toBe("`sample/a`");
    expect(listIds(["sample/a", "sample/b"])).toBe("`sample/a` and `sample/b`");
    expect(listIds(["sample/a", "sample/b", "sample/c"])).toBe(
      "`sample/a`, `sample/b` and `sample/c`",
    );
  });
});

describe("the references found", () => {
  it("finds a citation and says where it is", () => {
    const [site, ...rest] = sitesIn("// one\n// see (\`sample.md\` 1) here\n");
    expect(rest).toEqual([]);
    expect(site).toEqual({
      file: "a.ts",
      line: 2,
      column: 8,
      original: "\`sample.md\` 1",
      kind: "citation",
      numbers: [1],
      proposed: "`sample/a`",
      needs_choice: false,
      reasons: [],
    });
  });

  it("finds a path before the name and a list after it", () => {
    const sites = sitesIn(
      "\`conformance/spec/sample.md\` 1, 3 and 4; \`sample.md\` 3 to 4.",
    );
    expect(sites.map((s) => [s.original, s.proposed])).toEqual([
      [
        "`conformance/spec/sample.md` 1, 3 and 4",
        "`sample/a`, `sample/d` and `sample/e`",
      ],
      ["\`sample.md\` 3 to 4", "`sample/d` and `sample/e`"],
    ]);
  });

  it("finds a reference written over a line end, in a comment of any language", () => {
    for (const [text, original] of [
      ["// (\`sample.md\`\n// 3)", "\`sample.md\`\n// 3"],
      ["/// (\`sample.md\`\n/// 3)", "\`sample.md\`\n/// 3"],
      ["/** (\`sample.md\`\n *  3) */", "\`sample.md\`\n *  3"],
      ["# (\`sample.md\`\n#  3)", "\`sample.md\`\n#  3"],
      ["(\`sample.md\`\n3)", "\`sample.md\`\n3"],
      ["(\`sample.md\` 1,\n *  3)", "\`sample.md\` 1,\n *  3"],
    ] as const) {
      expect(
        sitesIn(text).map((s) => s.original),
        text,
      ).toEqual([original]);
    }
    expect(after("see (\`sample.md\`\n  * 3) now")).toBe(
      "see (`sample/d`) now",
    );
  });

  it("leaves a number that starts a list item in Markdown to a person", () => {
    const text = "See \`sample.md\`\n3. The next rule.\n";
    expect(sitesIn(text, "a.md").map((s) => s.reasons)).toEqual([
      ["the number may start a list item"],
    ]);
    expect(sitesIn(text, "a.ts").map((s) => s.reasons)).toEqual([[]]);
  });

  it("finds plain text and marks it", () => {
    const [site] = sitesIn("held (conformance/spec/sample.md 3).");
    expect(site.original).toBe("conformance/spec/sample.md 3");
    expect(site.kind).toBe("plain");
    expect(site.reasons).toEqual(["the reference is plain text"]);
    expect(site.needs_choice).toBe(true);
    expect(site.proposed).toBe("`sample/d`");
  });

  it("does not read the name inside another, or a number that goes on in letters", () => {
    expect(
      sitesIn("\`other-sample.md\` 3, xsample.md 3, \`sample.md\` 12th"),
    ).toEqual([]);
    expect(sitesIn("\`sample.md\`, \`sample.md\` and nothing")).toEqual([]);
  });

  it("marks what a person has to choose, and nothing else", () => {
    const flagged = (text: string) => sitesIn(text).map((s) => s.needs_choice);
    expect(flagged("\`sample.md\` 2")).toEqual([true]);
    expect(flagged("\`sample.md\` 1, 2")).toEqual([true]);
    expect(flagged("\`sample.md\` 3 to 7")).toEqual([true]);
    expect(flagged("\`sample.md\` 3 to 6")).toEqual([false]);
    expect(flagged("\`sample.md\` 99")).toEqual([true]);
    expect(flagged("\`sample.md\` 3")).toEqual([false]);
  });

  it("reads the chapter's own shorthand only in its own file", () => {
    const text =
      "As (3) and (1, 4) say, and statement 5 and statements 6 and 7.";
    expect(sitesIn(text)).toEqual([]);
    expect(
      sitesIn(text, "sample.md", true).map((s) => [s.original, s.proposed]),
    ).toEqual([
      ["(3)", "(`sample/d`)"],
      ["(1, 4)", "(`sample/a` and `sample/e`)"],
      ["statement 5", "`sample/f`"],
      ["statements 6 and 7", "`sample/g` and `sample/h`"],
    ]);
    expect(after(text, "sample.md", true)).toBe(
      "As (`sample/d`) and (`sample/a` and `sample/e`) say, and `sample/f` and `sample/g` and `sample/h`.",
    );
  });

  it("does not read a parenthesis around a citation as the shorthand", () => {
    const sites = sitesIn("(\`sample.md\` 3)", "sample.md", true);
    expect(sites.map((s) => s.kind)).toEqual(["citation"]);
  });
});

describe("the references rewritten", () => {
  it("rewrites every site, last first, and leaves the rest as it was", () => {
    expect(
      after(
        "a \`sample.md\` 1 b\n// \`sample.md\` 3 to 4\nc \`sample.md\` 5, 6",
      ),
    ).toBe(
      "a `sample/a` b\n// `sample/d` and `sample/e`\nc `sample/f` and `sample/g`",
    );
  });

  it("writes a person's choice in place of the proposal", () => {
    const text = "x \`sample.md\` 2 y (sample.md 3)";
    const sites = sitesIn(text);
    expect(unchosen(sites)).toEqual(["a.ts:1", "a.ts:1"]);
    sites[0].choice = ["sample/c"];
    sites[1].choice = "see `sample/d`";
    expect(unchosen(sites)).toEqual([]);
    expect(replacement(sites[0])).toBe("`sample/c`");
    expect(rewrite(text, sites)).toBe("x `sample/c` y (see `sample/d`)");
  });

  it("writes a chosen list inside the parentheses it replaced", () => {
    const [site] = sitesIn("(2)", "sample.md", true);
    site.choice = ["sample/b", "sample/c"];
    expect(rewrite("(2)", [site])).toBe("(`sample/b` and `sample/c`)");
  });

  it("refuses a file that changed since the plan, and writes nothing", () => {
    const text = "one \`sample.md\` 1";
    const sites = sitesIn(text);
    expect(() => rewrite(`two ${text}`, sites)).toThrow(
      "a.ts:1 no longer reads as planned",
    );
  });
});

describe("a decisions file against its map", () => {
  it("names the references to a number the map does not have", () => {
    const sites = sitesIn("\`sample.md\` 1 and 3\n\`sample.md\` 2\n");
    expect(outOfMap(sites, migration)).toEqual([]);
    expect(outOfMap(sites, { "1": ["sample/a"], "2": ["sample/b"] })).toEqual([
      "a.ts:1",
    ]);
  });
});

describe("the citations a moved chapter keeps", () => {
  const cited = "`compliance/a.test.ts › one`, `› two`";

  it("names a citation the chapter no longer makes", () => {
    expect(
      droppedCitations(
        `1. A rule. ${cited}, \`device/b.test.ts › three\`.`,
        `### \`sample/a\`\n\n**Tests:** ${cited}.\n`,
      ),
    ).toEqual(["device/b.test.ts › three"]);
  });

  it("reads none dropped when every one is kept, however it is written", () => {
    expect(
      droppedCitations(
        `1. A rule. ${cited}.`,
        `**Tests:** \`compliance/a.test.ts › two\`, \`compliance/a.test.ts › one\`, \`device/new.test.ts › added\`.`,
      ),
    ).toEqual([]);
  });
});
