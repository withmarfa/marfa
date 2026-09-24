import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The corpus against the chapters, with no server and no device.
 *
 * `spec-citations.test.ts` checks that a citation resolves. It cannot check
 * the other direction, and the other direction is the one that matters here:
 * a device statement with no citation is a rule nothing asserts, and it would
 * read exactly like a rule everything asserts.
 *
 * So: every device statement is cited, every citation reaches a device
 * fixture, and every fixture of the device's behavior is cited.
 */

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, "../../../spec");
const CHAPTERS = ["device.md", "queue-and-verdicts.md", "folders.md"];

const SPAN = /`([^`]+)`/g;
const CITED = /^(device\/[a-z0-9.-]+\.test\.ts)(?: › (.+))?$/;
const CONTINUED = /^› (.+)$/;
const TITLE = /(?:^|\s)it\(\s*"((?:[^"\\]|\\.)*)"/g;

interface Statement {
  chapter: string;
  number: string;
  text: string;
}

function statements(chapter: string): Statement[] {
  return read(chapter).found;
}

/**
 * A statement that goes on after a blank line, which this parser cannot read.
 *
 * The truncation is silent and the hole it leaves is worse than the one that
 * made it visible. A statement split into paragraphs with its citations in
 * the first one satisfies every check here — it has citations, and they
 * resolve — while whatever the later paragraphs claim is read by nothing.
 * `spec-citations.test.ts` does not cover it either: that one scans a chapter
 * whole and asks whether each citation resolves, never whether a statement
 * carries one.
 *
 * So the shape is refused rather than parsed. Every statement in the three
 * chapters is one paragraph, and a rule that needs two is a rule to split in
 * two.
 */
function orphanedContinuations(chapter: string): string[] {
  return read(chapter).orphans;
}

function read(chapter: string): { found: Statement[]; orphans: string[] } {
  const lines = readFileSync(resolve(specDir, chapter), "utf8").split("\n");
  const found: Statement[] = [];
  const orphans: string[] = [];
  let current: Statement | undefined;
  // The statement a blank line just ended, kept only until the next
  // non-blank line says whether that line meant to continue it.
  let ended: Statement | undefined;
  for (const line of lines) {
    const start = /^(\d+)\. (.*)$/.exec(line);
    if (start) {
      current = { chapter, number: start[1], text: start[2] };
      ended = undefined;
      found.push(current);
      continue;
    }
    if (/^\s*$/.test(line)) {
      ended = ended ?? current;
      current = undefined;
      continue;
    }
    // A statement prettier left wrapped continues on an indented line.
    if (current && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
      continue;
    }
    if (ended && /^\s+\S/.test(line)) {
      orphans.push(`${chapter} ${ended.number}: ${line.trim().slice(0, 60)}`);
    }
    ended = undefined;
  }
  return { found, orphans };
}

/**
 * Every `file › title` a statement cites, expanding the `› title` shorthand.
 *
 * Read span by span rather than by splitting the sentence, because a test
 * title carries commas as readily as the prose around it does and a split
 * would cut one in half and report the statement as citing nothing.
 */
function citationsIn(text: string): Array<{ file: string; title?: string }> {
  const out: Array<{ file: string; title?: string }> = [];
  let file: string | undefined;
  SPAN.lastIndex = 0;
  for (const span of text.matchAll(SPAN)) {
    const cited = CITED.exec(span[1]);
    if (cited) {
      file = cited[1];
      out.push({ file, title: cited[2] });
      continue;
    }
    const continued = CONTINUED.exec(span[1]);
    if (continued && file !== undefined)
      out.push({ file, title: continued[1] });
  }
  return out;
}

function titlesIn(file: string): string[] {
  const path = resolve(here, file.replace(/^device\//, ""));
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(TITLE)].map((match) =>
    match[1].replace(/\\`/g, "`"),
  );
}

const allStatements = CHAPTERS.flatMap(statements);
const fixtureFiles = readdirSync(here).filter(
  (name) => name.endsWith(".test.ts") && !name.endsWith(".decision.test.ts"),
);

describe("every device statement is asserted by something", () => {
  it("finds the device chapters and their statements", () => {
    expect(
      CHAPTERS.every((chapter) => existsSync(resolve(specDir, chapter))),
      "a device chapter is missing, so everything below is checking an empty set",
    ).toBe(true);
    // Contiguous from 1, per chapter, rather than a count over the three.
    // A loose floor lets most of a chapter fall out of the parse while every
    // check below passes on whatever survived, and it lets a renumbering
    // leave a gap nobody notices.
    for (const chapter of CHAPTERS) {
      const numbers = allStatements
        .filter((statement) => statement.chapter === chapter)
        .map((statement) => Number(statement.number));
      expect(
        numbers,
        `${chapter} did not parse to a run of statements numbered from 1, so either the parse is reading part of the chapter or the chapter has a gap`,
      ).toEqual(
        Array.from({ length: numbers.length }, (_, index) => index + 1),
      );
      expect(
        numbers.length,
        `${chapter} parsed to ${String(numbers.length)} statements, which is fewer than it carries`,
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it("reads every statement whole", () => {
    // The parse ends a statement at a blank line, so a statement written as
    // two paragraphs is read as its first one. That passes every check here
    // when the citations happen to sit in the first paragraph, and passes
    // `spec-citations.test.ts` too, which scans a chapter whole and asks
    // only whether each citation resolves. The later paragraphs would then
    // be a rule nothing reads, reported by nothing.
    const orphans = CHAPTERS.flatMap(orphanedContinuations);
    expect(
      orphans,
      "a statement goes on past a blank line, so the parse reads part of it and every check below is about the part it read",
    ).toEqual([]);
  });

  it("cites a fixture for every numbered statement", () => {
    const uncited = allStatements
      .filter((statement) => citationsIn(statement.text).length === 0)
      .map((statement) => `${statement.chapter} ${statement.number}`);
    expect(
      uncited,
      "a statement in a device chapter names no fixture, so it is a rule nothing checks and it reads exactly like a rule everything checks",
    ).toEqual([]);
  });

  it("cites only fixtures that exist, with titles that exist", () => {
    const unresolved: string[] = [];
    for (const statement of allStatements) {
      for (const citation of citationsIn(statement.text)) {
        const titles = titlesIn(citation.file);
        if (titles.length === 0) {
          unresolved.push(
            `${statement.chapter} ${statement.number}: ${citation.file} is missing`,
          );
          continue;
        }
        if (citation.title !== undefined && !titles.includes(citation.title)) {
          unresolved.push(
            `${statement.chapter} ${statement.number}: ${citation.file} › ${citation.title}`,
          );
        }
      }
    }
    expect(
      unresolved,
      "a device statement cites a fixture or a title that does not exist, so the statement is asserted by nothing at all",
    ).toEqual([]);
  });

  it("runs every device fixture rather than skipping one", () => {
    // A fixture that skips passes every check here: it is cited, its title
    // resolves, and it asserts nothing, so the statement citing it reads as
    // asserted while nothing runs it. One marked to fail is the same: it
    // passes when what it asserts is false.
    const SKIPS =
      /\b(?:skip|skipIf|runIf|todo|fails)\s*\(|\b(?:skip|todo|fails)\s*:\s*true\b/;
    // The witness: the check sees each way a fixture is skipped.
    for (const written of [
      "context.skip();",
      "({ skip }) => skip()",
      'it.skip("a fixture", () => {});',
      'it.skipIf(true)("a fixture", () => {});',
      'it.runIf(false)("a fixture", () => {});',
      'it.todo("a fixture");',
      'it.fails("a fixture", () => {});',
      'it("a fixture", { skip: true }, () => {});',
      'it("a fixture", { todo: true }, () => {});',
      'it("a fixture", { fails: true }, () => {});',
      'describe.skip("a chapter", () => {});',
    ]) {
      expect(SKIPS.test(written), written).toBe(true);
    }
    const skipping = fixtureFiles.filter((file) =>
      SKIPS.test(readFileSync(resolve(here, file), "utf8")),
    );
    expect(
      skipping,
      "a device fixture skips itself, so the statement citing it is asserted by nothing",
    ).toEqual([]);
    // The witness: the files read are the fixtures, so an empty list above
    // is every one of them read and not nothing read.
    expect(fixtureFiles).toContain("working-copy.test.ts");
  });

  it("cites every fixture of the device's behavior from some statement", () => {
    // The suite's own controls are not the device's behavior: fidelity holds
    // the scripting to the real server and the scripted server's own tests
    // hold the harness. Everything else asserts a rule, and a fixture no
    // statement cites is a rule written nowhere, whose citation could be
    // dropped with nothing failing.
    const CONTROLS = ["fidelity.test.ts", "scripted-server.test.ts"];
    const cited = new Set(
      allStatements.flatMap((statement) =>
        citationsIn(statement.text).map(
          (citation) => `${citation.file} › ${citation.title ?? ""}`,
        ),
      ),
    );
    const uncited = fixtureFiles
      .filter((file) => !CONTROLS.includes(file))
      .flatMap((file) =>
        titlesIn(`device/${file}`)
          .map((title) => `device/${file} › ${title}`)
          .filter((key) => !cited.has(key)),
      );
    expect(
      uncited,
      "a fixture of the device's behavior is cited by no statement, so the rule it asserts is written nowhere",
    ).toEqual([]);
    // The witness: the files read are the fixtures and their titles are
    // read, so an empty list above is every one of them cited and not
    // nothing read.
    expect(fixtureFiles).toContain("queue.test.ts");
    expect(
      titlesIn("device/queue.test.ts"),
      "no title was read from a fixture, so an empty list above checked nothing",
    ).not.toEqual([]);
  });
});
