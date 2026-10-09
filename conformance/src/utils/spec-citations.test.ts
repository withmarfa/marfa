import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureTitles } from "./fixture-titles.js";
import {
  checkReferences,
  indexOf,
  numberedReferences,
  readIndex,
  trackedTextFiles,
} from "./spec-references.js";
import { citationsInText, withoutDefinitions } from "./spec-statements.js";

/**
 * Every citation in `spec/` must name a fixture that exists: a file under
 * `src/suites/` and, when a title is given, a test or describe title in it.
 * A statement whose citation does not resolve is a statement nothing asserts.
 */

// From this file rather than from the working directory, which is the package
// root only when the run was started there.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const specDir = resolve(root, "spec");
const suitesDir = resolve(root, "src/suites");

interface Citation {
  spec: string;
  file: string;
  title?: string;
}

function citations(): Citation[] {
  const out: Citation[] = [];
  for (const name of readdirSync(specDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(resolve(specDir, name), "utf8");
    for (const found of citationsInText(text)) {
      out.push({ spec: name, file: found.file, title: found.title });
    }
  }
  return out;
}

function titlesIn(file: string): string[] {
  const text = readFileSync(resolve(suitesDir, file), "utf8");
  return fixtureTitles(text, true);
}

/** The citations whose title is not a test or describe title in its file. */
function unresolvedTitles(
  cited: Citation[],
  titlesOf: (file: string) => string[],
): string[] {
  const cache = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const c of cited) {
    if (!c.title) continue;
    const titles = cache.get(c.file) ?? titlesOf(c.file);
    cache.set(c.file, titles);
    const wanted = c.title.replace(/\\`/g, "`");
    if (!titles.some((t) => t === wanted)) {
      unresolved.push(`${c.spec}: ${c.file} › ${c.title}`);
    }
  }
  return unresolved;
}

describe("specification citations", () => {
  const all = citations();
  const repository = trackedTextFiles();

  it("finds citations to check", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("every cited fixture file exists", () => {
    const missing = [...new Set(all.map((c) => c.file))].filter(
      (file) => !existsSync(resolve(suitesDir, file)),
    );
    expect(missing).toEqual([]);
  });

  it("every cross-reference between the chapters names a statement that exists", () => {
    const index = readIndex();
    let checked = 0;
    const dangling: string[] = [];
    for (const [name, text] of index.files) {
      const found = checkReferences(name, text, index, { definitions: false });
      checked += found.checked;
      dangling.push(...found.problems);
    }
    // The positive control. A zero count would pass the assertion below for
    // the wrong reason, and these are read out of prose by a regex that has
    // to keep matching.
    expect(checked).toBeGreaterThan(20);
    expect(dangling).toEqual([]);
  });

  /**
   * The same check, over every other file in the repository: the code, its
   * comments and tests, and the documents.
   *
   * A comment citing a statement reads as authority, because it is how the
   * next person finds the rule a piece of code exists for, so one that
   * resolves to nothing sends them somewhere else entirely.
   *
   * This catches a statement that does not exist. It cannot catch one that
   * exists and is the wrong one; that needs a reader.
   */
  it("every reference outside the contract names a statement that exists", () => {
    const index = readIndex();
    let checked = 0;
    const dangling: string[] = [];
    for (const { path, text } of repository) {
      if (path.startsWith("conformance/spec/")) continue;
      const found = checkReferences(path, text, index);
      checked += found.checked;
      dangling.push(...found.problems);
    }
    // The positive control. These are read out of comments by a regex, and
    // a zero count passes the assertion below for the wrong reason.
    expect(
      checked,
      "no reference was found outside the contract at all, so the assertion below is about nothing",
    ).toBeGreaterThan(50);
    expect(dangling).toEqual([]);
  });

  /**
   * A statement is referred to by its ID, which survives a rule being
   * reworded, moved or split. A number names a place in a list that no
   * longer exists, so a reference by number points at nothing, or at
   * whatever a reader guesses it meant.
   */
  it("no file in the repository refers to a statement by number", () => {
    // The positive control: the walk reached the contract, the code and the
    // documents, so an empty list below is every file read.
    const paths = repository.map((file) => file.path);
    for (const expected of [
      "conformance/spec/items.md",
      "packages/server/src/app.ts",
      "core/marfa-core/src/lib.rs",
      "AGENTS.md",
    ]) {
      expect(paths, `${expected} was not read`).toContain(expected);
    }
    const numbered = repository.flatMap(({ path, text }) =>
      numberedReferences(text).map((line) => `${path} line ${String(line)}`),
    );
    expect(
      numbered,
      "These refer to a statement by number; refer to it by its ID",
    ).toEqual([]);
  });

  it("every cited title is a test or describe title in its file", () => {
    expect(
      unresolvedTitles(
        all.filter((c) => existsSync(resolve(suitesDir, c.file))),
        titlesIn,
      ),
    ).toEqual([]);
  });
});

/**
 * Witnesses for the checks above, on chapters written here. A check that
 * asserts there is nothing wrong needs a case that is wrong and is seen.
 * Backticks are escaped in every text below so that no source file in the
 * walk cites a chapter that does not exist.
 */
describe("the reference checks see what they are for", () => {
  const sample = [
    "# Sample",
    "",
    "## Rules",
    "",
    "### `sample/first-rule`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/second-rule`",
    "",
    "The server MUST answer again.",
    "",
    "**Tests:** waiting on #1.",
    "",
  ].join("\n");
  const index = indexOf({ "sample.md": sample, "other.md": "Prose.\n" });
  const check = (text: string) => checkReferences("a comment", text, index);

  it("reads an ID written for it", () => {
    expect([...index.ids]).toEqual(["sample/first-rule", "sample/second-rule"]);
    expect(check("See \`sample/first-rule\`.")).toEqual({
      checked: 1,
      problems: [],
    });
  });

  it("fails an ID that names no statement", () => {
    const found = check("See \`sample/third-rule\`.");
    expect(found.problems).toEqual([
      "a comment line 1: \`sample/third-rule\` (no such statement)",
    ]);
  });

  it("does not read a path or a fixture as an ID", () => {
    // `sample` is a chapter, so the first would be read as an ID if the
    // grammar let a dot through; the second names a directory of another
    // name altogether.
    expect(
      check("See \`sample/x.test.ts\` and \`routes/auth-pages\`."),
    ).toEqual({ checked: 0, problems: [] });
  });

  /**
   * The references below are put together at run time, so that this file's
   * own text, which the check reads, holds none of them.
   */
  describe("a reference by number", () => {
    const md = ".md";
    const word = "state" + "ment";
    const numbered = (text: string) => numberedReferences(text, ["sample"]);

    it("fails a chapter's file name and a number, however it is written", () => {
      for (const text of [
        `See sample${md} 5.`,
        `See \`sample${md}\` 5.`,
        `as in \`sample${md}\` ${word} 5`,
        `sample${md}'s ${word} 12 says so`,
        `the rule (sample 20) holds`,
        `the rule (\`sample${md}\` 20) holds`,
        `as ${word} 35 says`,
        `${word}s 3 and 4`,
        `(${word.replace("s", "S")} 81)`,
      ]) {
        expect(numbered(text), text).toEqual([1]);
      }
    });

    it("reads a reference wrapped onto the next line of a comment", () => {
      for (const text of [
        `// as the rule says (\`sample${md}\`\n// 35), so`,
        `/// the copy (sample${md}\n/// 52): the write`,
        ` * ${word}\n * 81 holds`,
        `# see sample${md}\n# 7 for it`,
        `see \`sample${md}\`\n12, the rule`,
      ]) {
        expect(numbered(text), text).toEqual([1]);
      }
    });

    it("names the line it is on", () => {
      expect(numbered(`First.\nSecond, sample${md} 2.\nThird.`)).toEqual([2]);
    });

    it("passes an ID, another file and a number, and a section of an RFC", () => {
      // The witness for each: a chapter, and a number near it, that are not
      // a reference by number.
      for (const text of [
        "See \`sample/first-rule\`.",
        `See README${md} 5.`,
        `sample${md}`,
        "RFC 8414 \u00a73.1",
        "the sample 5 times over",
        `See sample${md}.\n\n5. A list item`,
        `Read sample${md}\n5. A list item`,
        `Read sample${md}\n- 5 items`,
      ]) {
        expect(numbered(text), text).toEqual([]);
      }
    });
  });

  it("does not read a chapter's ID headings or a fenced example as references", () => {
    const text = [
      "### `sample/third-rule`",
      "",
      "```markdown",
      "See `sample/fourth-rule`.",
      "```",
      "",
      "## After",
      "",
      "See `sample/sixth-rule`.",
    ].join("\n");
    expect(withoutDefinitions(text).split("\n")).toHaveLength(9);
    expect(
      checkReferences("a chapter", text, index, { definitions: false }),
    ).toEqual({
      checked: 1,
      problems: ["a chapter line 9: \`sample/sixth-rule\` (no such statement)"],
    });
  });

  it("checks CLI citations and continued titles in an ID chapter", () => {
    const chapter = [
      "### `sample/cli-rule`",
      "",
      "The CLI MUST answer.",
      "",
      "**Tests:** `cli/folder.test.ts › no such CLI title`, `› no such continued CLI title`.",
    ].join("\n");
    const cited = citationsInText(chapter).map((c): Citation => ({
      spec: "sample.md",
      ...c,
    }));
    expect(cited).toHaveLength(2);
    expect(unresolvedTitles(cited, titlesIn)).toEqual([
      "sample.md: cli/folder.test.ts › no such CLI title",
      "sample.md: cli/folder.test.ts › no such continued CLI title",
    ]);
  });

  it("reads a citation in an ID statement's Tests paragraph and holds its title to the fixture", () => {
    const chapter = [
      "### `sample/cited-rule`",
      "",
      "The server MUST answer.",
      "",
      "**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the management key`, `› no such title in that file`.",
      "",
    ].join("\n");
    const cited = citationsInText(chapter).map((c): Citation => ({
      spec: "sample.md",
      ...c,
    }));
    expect(cited).toHaveLength(2);
    expect(unresolvedTitles(cited, titlesIn)).toEqual([
      "sample.md: compliance/housekeeping.test.ts › no such title in that file",
    ]);
  });
});
