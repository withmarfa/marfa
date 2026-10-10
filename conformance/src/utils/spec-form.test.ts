/**
 * Every chapter follows `spec/README.md`.
 *
 * Every rule asserted here is one the README states and a reader or a
 * script can check from the text alone. A failure lists each statement or
 * line that breaks the rule, by name: `<chapter> <id>` for a statement and
 * `<chapter> line <n>` for a line. The README and `coverage.md`, which hold
 * no statements, are outside it. A reference by number anywhere in the
 * repository is `spec-citations.test.ts`'s.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SPEC_DIR,
  citationsIn,
  isId,
  readChapter,
  readChapters,
  type Statement,
} from "./spec-statements.js";

/** The rules, each with the sentence a failure reports. */
const RULES = {
  hasStatements: "a chapter states at least one rule",
  noNumberedStatements:
    "no line opens with a number and a full stop, the shape of a numbered statement",
  idGrammar:
    "every ID is the chapter's name, a slash and a slug of lowercase words and digits joined by hyphens, at most 40 characters",
  idUnique: "every ID is stated once",
  blockShape:
    "a statement is a heading holding one ID, then one rule paragraph, an optional Reason paragraph and one Tests paragraph",
  ruleOneSentence:
    "the rule paragraph is one sentence, with no full stop followed by a capital letter outside a code span",
  oneRequirement:
    "a rule holds exactly one MUST or MUST NOT and no other key word of RFC 2119 in capitals",
  earsForm:
    "a rule opens as one of the EARS patterns does and its subject is the server, a device or the CLI",
  testsShape:
    "a Tests paragraph holds fixture citations ending in a period, or exactly the words waiting on and an issue number, and never both",
  noServerTests: "a statement never names the server's own tests",
  noNumberedRefs:
    "a chapter refers to a statement by its ID, never by a bare number in parentheses",
  normativeOutside:
    "no key word of RFC 2119 in capitals stands outside a rule paragraph",
  emDash: "no em dash",
} as const;

type Rule = keyof typeof RULES;

const ANY_KEYWORD =
  /\b(?:MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/;
const OTHER_KEYWORD = /\b(?:SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/;

const SUBJECT = "(?:the server|a device|the CLI)";
const UBIQUITOUS = /^(?:The server|A device|The CLI)$/;
// A state or an event, with an unwanted condition inside it; or the
// unwanted condition alone.
const EARS = new RegExp(
  `^(?:(?:When|While|Where) .+?, (?:if .+?, then )?|If .+?, then )${SUBJECT}$`,
);

const CITATION =
  "`(?:(?:correctness|compliance|device|sync|cli)/[a-z0-9./-]+\\.test\\.ts › [^`]+|› [^`]+)`";
const CITATIONS = new RegExp(`^${CITATION}(?:, ${CITATION})*\\.$`);
const WAITING = /^waiting on #\d+\.$/;

function empty(): Record<Rule, string[]> {
  return Object.fromEntries(
    (Object.keys(RULES) as Rule[]).map((rule) => [rule, []]),
  ) as unknown as Record<Rule, string[]>;
}

/** Whether a statement's paragraphs are one rule, perhaps a reason, and tests. */
function shaped(statement: Statement): boolean {
  const kinds = (statement.paragraphs ?? []).map((p) => p.kind).join(" ");
  return kinds === "rule tests" || kinds === "rule reason tests";
}

/** What breaks each rule in one chapter, named so a failure says where to look. */
function violations(name: string, text: string): Record<Rule, string[]> {
  const found = empty();
  const chapter = readChapter(text);
  const lines = text.split("\n");
  const where = (id: string) => `${name} ${id}`;
  const at = (line: number) => `${name} line ${String(line)}`;

  if (chapter.statements.length === 0) found.hasStatements.push(name);

  const seen = new Set<string>();
  for (const { id } of chapter.statements) {
    if (!isId(name, id)) found.idGrammar.push(where(id));
    if (seen.has(id)) found.idUnique.push(where(id));
    seen.add(id);
  }

  const ruleLines = new Set<number>();
  for (const statement of chapter.statements) {
    const id = statement.id;
    if (!shaped(statement)) found.blockShape.push(where(id));
    for (const paragraph of statement.paragraphs) {
      if (paragraph.kind !== "rule") continue;
      for (let n = paragraph.line; n <= paragraph.end; n++) ruleLines.add(n);
      if (/\. [A-Z]/.test(paragraph.text.replace(/`[^`]*`/g, ""))) {
        found.ruleOneSentence.push(where(id));
      }
    }

    const rule = statement.rule.replace(/\s+/g, " ").trim();
    const musts = rule.match(/\bMUST(?: NOT)?\b/g) ?? [];
    if (musts.length !== 1 || OTHER_KEYWORD.test(rule)) {
      found.oneRequirement.push(where(id));
    }
    const must = rule.search(/\bMUST\b/);
    if (must !== -1) {
      const before = rule.slice(0, must).trim();
      if (!UBIQUITOUS.test(before) && !EARS.test(before)) {
        found.earsForm.push(where(id));
      }
    }

    if (statement.tests !== undefined) {
      const tests = statement.tests.trim();
      const spans = tests.match(/`[^`]+`/g) ?? [];
      const cited =
        CITATIONS.test(tests) && citationsIn(tests).length === spans.length;
      if (!cited && !WAITING.test(tests)) found.testsShape.push(where(id));
    }

    const whole = statement.paragraphs.map((p) => p.text).join(" ");
    if (whole.includes("packages/server/src"))
      found.noServerTests.push(where(id));
  }
  for (const line of chapter.stray) found.blockShape.push(at(line));

  lines.forEach((line, index) => {
    if (/^\s*\d+\. /.test(line)) found.noNumberedStatements.push(at(index + 1));
    if (/\(\d+(?:(?:,| and| to) ?\d+)*\)/.test(line)) {
      found.noNumberedRefs.push(at(index + 1));
    }
    if (!ruleLines.has(index + 1) && ANY_KEYWORD.test(line)) {
      found.normativeOutside.push(at(index + 1));
    }
    if (line.includes("\u2014")) found.emDash.push(at(index + 1));
  });
  return found;
}

// The witness below is what shows each rule can fail.
describe("the chapters", () => {
  const chapters = [...readChapters()];
  it("are read", () => {
    expect(chapters.map(([name]) => name)).toContain("items");
  });
  const found = empty();
  for (const [name] of chapters) {
    const one = violations(
      name,
      readFileSync(resolve(SPEC_DIR, `${name}.md`), "utf8"),
    );
    for (const rule of Object.keys(RULES) as Rule[]) {
      found[rule].push(...one[rule]);
    }
  }

  for (const rule of Object.keys(RULES) as Rule[]) {
    it(`holds: ${RULES[rule]}`, () => {
      expect(found[rule], `These break the rule that ${RULES[rule]}`).toEqual(
        [],
      );
    });
  }
});

describe("the form check sees what it is for", () => {
  // The chapter is called `sample`, which no chapter is, so the IDs written
  // here are not read as references by the checks that walk this file's
  // source.
  const GOOD = [
    "# Sample",
    "",
    "An introduction. It states no rule.",
    "",
    "## Always",
    "",
    "### `sample/always`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** `compliance/a.test.ts › one`, `› two`.",
    "",
    "### `sample/on-event`",
    "",
    "When a key asks, the server MUST NOT answer.",
    "",
    "**Reason:** a reason, which may say anything but a rule.",
    "",
    "**Tests:** waiting on #12.",
    "",
    "### `sample/in-state`",
    "",
    "While a run is in progress, a device MUST wait.",
    "",
    "**Tests:** `device/b.test.ts › waits`.",
    "",
    "### `sample/feature-event`",
    "",
    "Where a setting is on, if a key asks, then the CLI MUST refuse.",
    "",
    "**Tests:** `sync/c.test.ts › refuses`.",
    "",
    "### `sample/unwanted`",
    "",
    "If a key is spent, then the server MUST refuse it.",
    "",
    "**Tests:** `correctness/d.test.ts › refuses`.",
    "",
    "### `sample/code-span`",
    "",
    "The server MUST answer `a. B` and keep it.",
    "",
    "**Tests:** waiting on #2.",
    "",
  ].join("\n");

  const BAD = [
    "# Sample",
    "",
    "An introduction in which the server MUST hold. INTRO",
    "",
    "1. A numbered statement. NUMBERED",
    "",
    "## Rules",
    "",
    "### `sample/Bad_Id`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/twice`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/twice`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/two-musts`",
    "",
    "The server MUST answer and MUST NOT wait.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/other-keyword`",
    "",
    "The server MUST answer and MAY wait.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/two-sentences`",
    "",
    "The server MUST answer. It then waits.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/no-keyword`",
    "",
    "The server answers.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/no-pattern`",
    "",
    "Answering is what the server MUST do.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/no-comma`",
    "",
    "When asked the server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/no-then`",
    "",
    "If asked, the server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/wrong-subject`",
    "",
    "When asked, the client MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    // The tool's subject before the CLI was named; it stays refused.
    "### `sample/old-subject`",
    "",
    "When asked, the command MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/both-tests`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** `compliance/a.test.ts › one`, waiting on #1.",
    "",
    "### `sample/no-period`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** `compliance/a.test.ts › one`",
    "",
    "### `sample/orphan-shorthand`",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** `› one`.",
    "",
    "### `sample/server-test`",
    "",
    "The server MUST answer.",
    "",
    "**Reason:** proven in packages/server/src/housekeeping/a.test.ts.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/no-tests`",
    "",
    "The server MUST answer.",
    "",
    "### `sample/two-rules`",
    "",
    "The server MUST answer.",
    "",
    "The server MUST also wait.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/reason-first`",
    "",
    "**Reason:** a reason.",
    "",
    "The server MUST answer.",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/numbered-refs`",
    "",
    "The server MUST answer.",
    "",
    "**Reason:** as in (3) and (4, 5). REFS",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### `sample/keyword-outside`",
    "",
    "The server MUST answer.",
    "",
    "**Reason:** the server SHOULD say why. OUTSIDE",
    "",
    "**Tests:** waiting on #1.",
    "",
    "### A plain heading STRAY",
    "",
    "A paragraph.",
    "",
    "### `sample/em-dash`",
    "",
    "The server MUST answer.",
    "",
    "**Reason:** a reason \u2014 with a dash. DASH",
    "",
    "**Tests:** waiting on #1.",
    "",
  ].join("\n");

  const line = (marker: string) =>
    BAD.split("\n").findIndex((l) => l.includes(marker)) + 1;
  const at = (marker: string) => `sample line ${String(line(marker))}`;
  const s = (id: string) => `sample sample/${id}`;

  it("fails a chapter that states no rule", () => {
    expect(violations("sample", "# Sample\n\nProse.\n").hasStatements).toEqual([
      "sample",
    ]);
  });

  it("accepts CLI fixtures and continued titles", () => {
    const text = [
      "### `sample/cli-rule`",
      "",
      "The CLI MUST answer.",
      "",
      "**Tests:** `cli/folder.test.ts › one`, `› two`.",
    ].join("\n");
    expect(violations("sample", text)).toEqual(empty());
  });

  it("passes a chapter that follows the form in every way it may", () => {
    const readable = readChapter(GOOD);
    expect(
      readable.statements.map((statement) => statement.id),
      "the parse read fewer statements than the text holds, so the clean result below is about part of it",
    ).toEqual([
      "sample/always",
      "sample/on-event",
      "sample/in-state",
      "sample/feature-event",
      "sample/unwanted",
      "sample/code-span",
    ]);
    expect(violations("sample", GOOD)).toEqual(empty());
  });

  it("names every statement and line that breaks a rule, and only those", () => {
    // The offenders are the ones the text above was written to produce.
    // Anything else in the list, or one missing, is the check disagreeing
    // with the README about what a rule means.
    expect(violations("sample", BAD)).toEqual({
      hasStatements: [],
      noNumberedStatements: [at("NUMBERED")],
      idGrammar: [s("Bad_Id")],
      idUnique: [s("twice")],
      blockShape: [
        s("no-tests"),
        s("two-rules"),
        s("reason-first"),
        at("STRAY"),
      ],
      ruleOneSentence: [s("two-sentences")],
      oneRequirement: [s("two-musts"), s("other-keyword"), s("no-keyword")],
      earsForm: [
        s("no-pattern"),
        s("no-comma"),
        s("no-then"),
        s("wrong-subject"),
        s("old-subject"),
      ],
      testsShape: [s("both-tests"), s("no-period"), s("orphan-shorthand")],
      noServerTests: [s("server-test")],
      noNumberedRefs: [at("REFS")],
      normativeOutside: [at("INTRO"), at("OUTSIDE")],
      emDash: [at("DASH")],
    });
  });
});
