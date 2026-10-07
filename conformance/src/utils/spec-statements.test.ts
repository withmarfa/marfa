import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chapterIds,
  chapterNames,
  citationsIn,
  citationsInText,
  isId,
  migratedChapters,
  readChapter,
  readChapters,
  statementText,
  withoutDefinitions,
} from "./spec-statements.js";

// The chapters below are called `sample`, which no chapter is, so the IDs
// written in this file are not read as references by the checks that walk
// its source.

describe("a numbered chapter", () => {
  const cited = "`device/stop.test.ts › a stopped call`";

  it("reads a statement, its wrapped continuation, its reason and its tests", () => {
    const chapter = readChapter(
      "sample.md",
      `# Sample\n\n1. A rule\n   that wraps.\n\n**Reason:** why.\n\n**Tests:** ${cited}\n\n2. Another.\n`,
    );
    expect(chapter.form).toBe("numbered");
    expect(chapter.statements).toEqual([
      {
        key: "1",
        rule: "A rule that wraps.",
        reason: "why.",
        tests: cited,
        line: 3,
      },
      { key: "2", rule: "Another.", line: 10 },
    ]);
    expect(statementText(chapter.statements[0])).toBe(
      `A rule that wraps. ${cited}`,
    );
    expect(chapter.orphans).toEqual([]);
  });

  it("refuses a rule that goes on after a blank line, and names it", () => {
    const chapter = readChapter(
      "sample.md",
      "1. A rule.\n\n  A second paragraph of it.\n",
    );
    expect(chapter.orphans).toEqual(["sample.md 1: A second paragraph of it."]);
    expect(chapter.statements[0].rule).toBe("A rule.");
  });

  it("does not carry Tests across a heading or a paragraph of prose", () => {
    for (const boundary of ["## Another", "Some prose."]) {
      const chapter = readChapter(
        "sample.md",
        `1. A rule.\n\n${boundary}\n\n**Tests:** ${cited}\n`,
      );
      expect(chapter.statements[0].tests, boundary).toBeUndefined();
    }
  });
});

describe("a chapter in the ID form", () => {
  const text = [
    "# Sample",
    "",
    "An introduction. It says the server MUST nothing.",
    "",
    "## First",
    "",
    "### `sample/one`",
    "",
    "When asked, the server MUST answer",
    "with both fields.",
    "",
    "**Reason:** why.",
    "",
    "**Tests:** `compliance/a.test.ts › one`, `› two`.",
    "",
    "### `sample/two`",
    "",
    "The server MUST wait.",
    "",
    "```text",
    "### `sample/fenced`",
    "```",
    "",
    "**Tests:** waiting on #7.",
    "",
    "## Retired",
    "",
    "- `sample/old`: withdrawn.",
    "",
  ].join("\n");
  const chapter = readChapter("sample", text);

  it("is read as the ID form", () => {
    expect(chapter.form).toBe("id");
  });

  it("reads each statement's rule, reason, tests and line", () => {
    expect(chapter.statements.map((s) => [s.key, s.line])).toEqual([
      ["sample/one", 7],
      ["sample/two", 16],
    ]);
    const [one, two] = chapter.statements;
    expect(one.rule).toBe(
      "When asked, the server MUST answer with both fields.",
    );
    expect(one.reason).toBe("why.");
    expect(one.tests).toBe("`compliance/a.test.ts › one`, `› two`.");
    expect(one.paragraphs?.map((p) => [p.kind, p.line, p.end])).toEqual([
      ["rule", 9, 10],
      ["reason", 12, 12],
      ["tests", 14, 14],
    ]);
    expect(two.paragraphs?.map((p) => p.kind)).toEqual([
      "rule",
      "rule",
      "tests",
    ]);
  });

  it("does not read a heading inside a fenced block", () => {
    expect(chapter.statements.map((s) => s.key)).not.toContain("sample/fenced");
  });

  it("reads a Retired section as an ordinary section", () => {
    expect(chapter.statements.map((s) => s.key)).toEqual([
      "sample/one",
      "sample/two",
    ]);
    expect(chapter.stray).toEqual([]);
    const retired = readChapter(
      "sample",
      "## Retired\n\n### `sample/old`\n\nThe server MUST wait.\n",
    );
    expect(retired.statements.map((s) => s.key)).toEqual(["sample/old"]);
    expect(chapterIds(chapter)).toEqual(["sample/one", "sample/two"]);
  });

  it("sets aside a heading that is not one ID, at any level but 1 and 2", () => {
    const stray = readChapter(
      "sample",
      "### `sample/a` and more\n\nText.\n\n#### `sample/b`\n\n### Plain\n",
    );
    expect(stray.form).toBe("none");
    expect(stray.stray).toEqual([1, 5, 7]);
  });
});

describe("the form of a chapter", () => {
  it("is numbered, id, mixed or none by what it holds", () => {
    const formOf = (text: string) => readChapter("sample", text).form;
    expect(formOf("1. A rule.\n")).toBe("numbered");
    expect(formOf("### `sample/a`\n\nThe server MUST.\n")).toBe("id");
    expect(formOf("1. A rule.\n\n### `sample/a`\n")).toBe("mixed");
    expect(formOf("# Sample\n\nProse.\n\n### Plain heading\n")).toBe("none");
  });
});

describe("what the references checks leave out", () => {
  it("blanks ID headings and fenced blocks, line for line", () => {
    const text = [
      "### `sample/a`",
      "Keep `sample/b`.",
      "```",
      "`sample/c`",
      "```",
      "## Next",
      "Keep `sample/e`.",
    ].join("\n");
    expect(withoutDefinitions(text).split("\n")).toEqual([
      "",
      "Keep `sample/b`.",
      "",
      "",
      "",
      "## Next",
      "Keep `sample/e`.",
    ]);
  });
});

describe("the grammar of an ID", () => {
  it("is the chapter, a slash and a slug of at most 40 characters", () => {
    expect(isId("sample", "sample/a-rule-2")).toBe(true);
    expect(isId("sample", `sample/${"a".repeat(40)}`)).toBe(true);
    for (const id of [
      "sample/",
      "other/a-rule",
      "sample/A-rule",
      "sample/a_rule",
      "sample/2-rules",
      "sample/a--rule",
      "sample/a-rule-",
      "sample/a.rule",
      `sample/${"a".repeat(41)}`,
    ]) {
      expect(isId("sample", id), id).toBe(false);
    }
  });
});

describe("the citations in a text", () => {
  it("expands the shorthand only after a comma and a space", () => {
    expect(
      citationsIn("`compliance/a.test.ts › one`, `› two`, `› three`."),
    ).toEqual([
      { file: "compliance/a.test.ts", title: "one" },
      { file: "compliance/a.test.ts", title: "two" },
      { file: "compliance/a.test.ts", title: "three" },
    ]);
    expect(
      citationsIn("`compliance/a.test.ts › one` and, separately, `› two`."),
    ).toEqual([{ file: "compliance/a.test.ts", title: "one" }]);
  });

  it("does not continue a fixture's file from a citation of anything else", () => {
    expect(
      citationsIn(
        "`compliance/a.test.ts › one`, `packages/x/src/b.test.ts › two`, `› three`.",
      ),
    ).toEqual([{ file: "compliance/a.test.ts", title: "one" }]);
  });

  it("reads a citation with no title and does not read a shorthand with no file", () => {
    expect(citationsIn("`sync/a.test.ts`, `› one`")).toEqual([
      { file: "sync/a.test.ts", title: undefined },
      { file: "sync/a.test.ts", title: "one" },
    ]);
    expect(citationsIn("`› one`")).toEqual([]);
  });

  it("does not continue a file across a blank line", () => {
    expect(citationsInText("`device/a.test.ts › one`\n\n`› two`")).toEqual([
      { file: "device/a.test.ts", title: "one" },
    ]);
  });
});

describe("the chapters in a directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "marfa-spec-statements-"));
  const write = (name: string, text: string) =>
    writeFileSync(join(directory, name), text);
  write("README.md", "### `sample/a`\n");
  write("coverage.md", "1. Row.\n");
  write("findings.md", "## 1. A finding\n");
  write("Reading Notes.md", "1. Prose.\n");
  write("alpha.md", "1. A rule.\n");
  write(
    "beta-gamma.md",
    "### `beta-gamma/a`\n\nThe server MUST.\n\n**Tests:** waiting on #1.\n",
  );
  write("notes.txt", "1. Not a chapter.\n");

  it("lists the files that hold statements, by name", () => {
    expect(chapterNames(directory)).toEqual(["alpha", "beta-gamma"]);
    expect(chapterNames(join(directory, "none"))).toEqual([]);
  });

  it("reads each and names the ones in the ID form as migrated", () => {
    const read = readChapters(directory);
    expect(read.get("alpha")?.form).toBe("numbered");
    expect(read.get("beta-gamma")?.form).toBe("id");
    expect(migratedChapters(directory)).toEqual(["beta-gamma"]);
    rmSync(directory, { recursive: true });
  });
});
