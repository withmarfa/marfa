import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chapterNames,
  citationsIn,
  citationsInText,
  isId,
  readChapter,
  readChapters,
  statementText,
  withoutDefinitions,
} from "./spec-statements.js";

// The chapters below are called `sample`, which no chapter is, so the IDs
// written in this file are not read as references by the checks that walk
// its source.

describe("a chapter", () => {
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
  ].join("\n");
  const chapter = readChapter(text);

  it("reads each statement's rule, reason, tests and line", () => {
    expect(chapter.statements.map((s) => [s.id, s.line])).toEqual([
      ["sample/one", 7],
      ["sample/two", 16],
    ]);
    const [one, two] = chapter.statements;
    expect(one.rule).toBe(
      "When asked, the server MUST answer with both fields.",
    );
    expect(one.reason).toBe("why.");
    expect(one.tests).toBe("`compliance/a.test.ts › one`, `› two`.");
    expect(one.paragraphs.map((p) => [p.kind, p.line, p.end])).toEqual([
      ["rule", 9, 10],
      ["reason", 12, 12],
      ["tests", 14, 14],
    ]);
    expect(two.paragraphs.map((p) => p.kind)).toEqual([
      "rule",
      "rule",
      "tests",
    ]);
  });

  it("does not read a heading inside a fenced block", () => {
    expect(chapter.statements.map((s) => s.id)).not.toContain("sample/fenced");
  });

  it("lists the chapter's IDs in order", () => {
    expect(chapter.statements.map((s) => s.id)).toEqual([
      "sample/one",
      "sample/two",
    ]);
    expect(chapter.stray).toEqual([]);
  });

  it("gives a statement's rule and tests as one text", () => {
    expect(statementText(chapter.statements[0])).toBe(
      "When asked, the server MUST answer with both fields. `compliance/a.test.ts › one`, `› two`.",
    );
  });

  it("sets aside a heading that is not one ID, at any level but 1 and 2", () => {
    const stray = readChapter(
      "### `sample/a` and more\n\nText.\n\n#### `sample/b`\n\n### Plain\n",
    );
    expect(stray.statements).toEqual([]);
    expect(stray.stray).toEqual([1, 5, 7]);
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
  it("reads CLI citations as it reads the other projects'", () => {
    const tests =
      "`cli/folder.test.ts › one`, `› two`, `device/folders.test.ts › three`, `› four`.";
    expect(citationsIn(tests)).toEqual([
      { file: "cli/folder.test.ts", title: "one" },
      { file: "cli/folder.test.ts", title: "two" },
      { file: "device/folders.test.ts", title: "three" },
      { file: "device/folders.test.ts", title: "four" },
    ]);
    expect(
      citationsIn("`cli/folder.test.ts › one`, `not a fixture`, `› two`."),
    ).toEqual([{ file: "cli/folder.test.ts", title: "one" }]);
  });

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
  write("coverage.md", "| Row |\n");
  write("Reading Notes.md", "Prose.\n");
  write(
    "alpha.md",
    "### `alpha/a`\n\nThe server MUST.\n\n**Tests:** waiting on #1.\n",
  );
  write(
    "beta-gamma.md",
    "### `beta-gamma/a`\n\nThe server MUST.\n\n**Tests:** waiting on #1.\n",
  );
  write("notes.txt", "Not a chapter.\n");

  it("lists the files that hold statements, by name", () => {
    expect(chapterNames(directory)).toEqual(["alpha", "beta-gamma"]);
    expect(chapterNames(join(directory, "none"))).toEqual([]);
  });

  it("reads each", () => {
    const read = readChapters(directory);
    expect(read.get("alpha")?.statements.map((s) => s.id)).toEqual(["alpha/a"]);
    expect(read.get("beta-gamma")?.statements.map((s) => s.id)).toEqual([
      "beta-gamma/a",
    ]);
    rmSync(directory, { recursive: true });
  });
});
