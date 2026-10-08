import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureTitles } from "./fixture-titles.js";
import {
  checkReferences,
  indexOf,
  numbersIn,
  readIndex,
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

/** Every file under `dir` with this extension, at any depth. */
function walk(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, extension));
    else if (entry.name.endsWith(extension)) found.push(path);
  }
  return found;
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

/** The source files whose comments cite the chapters. */
function sourceFiles(): string[] {
  return [
    ...walk(resolve(root, "..", "core", "marfa-core", "src"), ".rs"),
    ...walk(resolve(root, "..", "core", "marfa-cli", "src"), ".rs"),
    ...walk(resolve(root, "..", "core", "bindings", "swift", "src"), ".rs"),
    ...walk(resolve(root, "..", "core", "bindings", "node", "src"), ".rs"),
    ...readdirSync(resolve(root, "..", "packages")).flatMap((name) => {
      const dir = resolve(root, "..", "packages", name, "src");
      return existsSync(dir) ? walk(dir, ".ts") : [];
    }),
    ...walk(resolve(root, "src"), ".ts"),
  ];
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

  it("finds citations to check", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("every cited fixture file exists", () => {
    const missing = [...new Set(all.map((c) => c.file))].filter(
      (file) => !existsSync(resolve(suitesDir, file)),
    );
    expect(missing).toEqual([]);
  });

  it("numbers findings.md's entries 1..n with no gap", () => {
    // What makes a citation to one checkable at all. A renumbering that
    // drops or repeats a number leaves every citation past it pointing one
    // entry off, and each of those still resolves, so existence alone cannot
    // see it. The headings are the file's own numbering, and this is the one
    // statement about them that does not need to know what they say.
    //
    // The positive control is written here rather than read from the file,
    // because the file is emptied by design: an entry goes when the
    // behavior it recorded changes, and a file with none left has no
    // heading to show the parse works, so a control that needed one would
    // fail on the day the last finding is fixed.
    const witness = [
      ...numbersIn("## 1. A first finding\n\nIts body.\n\n## 2. A second\n"),
    ];
    expect(
      witness,
      "the heading parse read nothing from two headings written for it, so the check on the file below is about nothing",
    ).toEqual([1, 2]);
    const numbered = [
      ...numbersIn(readFileSync(resolve(specDir, "findings.md"), "utf8")),
    ].sort((a, b) => a - b);
    expect(numbered).toEqual(numbered.map((_, index) => index + 1));
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
    // to keep matching. Numbered references and ID references count
    // together, so the floor holds as chapters move from one to the other.
    expect(checked).toBeGreaterThan(20);
    expect(dangling).toEqual([]);
  });

  /**
   * The same check, over the code that cites the chapters.
   *
   * A comment citing a statement reads as authority, because it is how the
   * next person finds the rule a piece of code exists for, so one that
   * resolves to nothing sends them somewhere else entirely.
   *
   * This catches a statement that does not exist. It cannot catch one that
   * exists and is the wrong one; that needs a reader.
   */
  it("every citation in the code names a statement that exists", () => {
    const index = readIndex();
    let checked = 0;
    const dangling: string[] = [];
    for (const file of sourceFiles()) {
      const found = checkReferences(
        relative(resolve(root, ".."), file),
        readFileSync(file, "utf8"),
        index,
      );
      checked += found.checked;
      dangling.push(...found.problems);
    }
    // The positive control. These are read out of comments by a regex, and
    // a zero count passes the assertion below for the wrong reason.
    expect(
      checked,
      "no citation was found in the code at all, so the assertion below is about nothing",
    ).toBeGreaterThan(50);
    expect(dangling).toEqual([]);
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
  const older = "1. A rule.\n2. Another rule.\n3. A third rule.\n";
  const index = indexOf({
    "sample.md": sample,
    "older.md": older,
    "other.md": "Prose.\n",
  });
  const check = (text: string) => checkReferences("a comment", text, index);

  it("reads an ID and a number written for it", () => {
    expect(index.chapters.get("sample")?.form).toBe("id");
    expect(index.chapters.get("older")?.form).toBe("numbered");
    expect([...index.ids]).toEqual(["sample/first-rule", "sample/second-rule"]);
    expect(check("See \`sample/first-rule\` and \`older.md\` 3.")).toEqual({
      checked: 2,
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
      check(
        "See \`sample/x.test.ts\`, \`older/first\` and \`routes/auth-pages\`.",
      ),
    ).toEqual({ checked: 0, problems: [] });
  });

  it("fails a number into a chapter that has IDs, because it has no numbers", () => {
    expect(check("The rule (\`sample.md\` 1).").problems).toEqual([
      "a comment line 1: sample.md 1 (the chapter states its rules by ID, so it has no such number)",
    ]);
    expect(check("Rules \`sample.md\` 1 and 2.").problems).toEqual([
      "a comment line 1: sample.md 1 (the chapter states its rules by ID, so it has no such number)",
      "a comment line 1: sample.md 2 (the chapter states its rules by ID, so it has no such number)",
    ]);
  });

  it("still fails a number past the end of a numbered chapter", () => {
    expect(check("See \`older.md\` 4.").problems).toEqual([
      "a comment line 1: older.md 4",
    ]);
  });

  it("counts numbered and ID references together", () => {
    expect(
      check("\`older.md\` 1, 2 and 3; \`sample/first-rule\`.").checked,
    ).toBe(4);
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
