import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING } from "./pending.js";

/**
 * The corpus against the chapters, with no server and no device.
 *
 * `spec-citations.test.ts` checks that a citation resolves. It cannot check
 * the other direction, and the other direction is the one that matters here:
 * a device statement with no citation is a rule nothing asserts, and it would
 * read exactly like a rule everything asserts. Nor can it see the pending
 * list, which is the only thing standing between "this statement is asserted"
 * and "this statement has a test that skips".
 *
 * So: every device statement is cited, every citation reaches a device
 * fixture, every pending entry names a statement that exists and a test that
 * exists, and a fixture with no body is pending. The last two together are
 * what make the list shrink honestly — a body removed from the list without
 * being written throws, and a body written but left on the list is caught
 * here.
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
  const lines = readFileSync(resolve(specDir, chapter), "utf8").split("\n");
  const found: Statement[] = [];
  let current: Statement | undefined;
  for (const line of lines) {
    const start = /^(\d+)\. (.*)$/.exec(line);
    if (start) {
      current = { chapter, number: start[1], text: start[2] };
      found.push(current);
      continue;
    }
    // A statement prettier left wrapped continues on an indented line.
    if (current && /^\s+\S/.test(line)) current.text += ` ${line.trim()}`;
    else current = undefined;
  }
  return found;
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

/** A fixture whose body is `notWrittenYet` asserts nothing and must be pending. */
function bodilessTitles(file: string): string[] {
  const path = resolve(here, file);
  const text = readFileSync(path, "utf8");
  const blocks = text.split(/(?=(?:^|\s)it\(\s*")/);
  const bodiless: string[] = [];
  for (const block of blocks) {
    TITLE.lastIndex = 0;
    const title = TITLE.exec(block);
    if (title && block.includes("notWrittenYet(")) bodiless.push(title[1]);
  }
  return bodiless;
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
    expect(
      allStatements.length,
      "the chapters parsed to fewer statements than they carry, so the checks below are looking at part of the contract",
    ).toBeGreaterThan(50);
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
});

describe("the pending list and the fixtures agree", () => {
  it("names a fixture that exists for every pending entry", () => {
    const missing = Object.keys(PENDING).filter((key) => {
      const [file, title] = key.split(" › ");
      return !titlesIn(`device/${file}`).includes(title);
    });
    expect(
      missing,
      "a pending entry names a test that does not exist, so the list is carrying a statement nothing will ever turn green",
    ).toEqual([]);
  });

  it("names a statement that exists for every pending entry", () => {
    const unknown: string[] = [];
    for (const [key, statement] of Object.entries(PENDING)) {
      const [chapter, number] = statement.split(" ");
      const match = allStatements.find(
        (candidate) =>
          candidate.chapter === chapter && candidate.number === number,
      );
      if (!match) unknown.push(`${key} -> ${statement}`);
    }
    expect(
      unknown,
      "a pending entry names a statement no chapter carries, so nobody can tell what writing the fixture would prove",
    ).toEqual([]);
  });

  it("keeps every fixture with no body on the list, and every fixture with one off it", () => {
    const bodiless = new Set(
      fixtureFiles.flatMap((file) =>
        bodilessTitles(file).map((title) => `${file} › ${title}`),
      ),
    );
    const listed = new Set(Object.keys(PENDING));

    const unlisted = [...bodiless].filter((key) => !listed.has(key)).sort();
    expect(
      unlisted,
      "a fixture with no body is not on the pending list, so it fails as though the device were broken rather than reporting the statement it is waiting for",
    ).toEqual([]);
  });

  it("lets a written fixture stay on the list, because that one polices itself", () => {
    // A pending fixture whose body is written runs its assertions and is
    // required to fail (`pendingUntilItPasses`), so the day the device
    // satisfies it the run goes red asking for the entry to be removed. It is
    // the only kind of entry this file does not have to police, and naming
    // that here is cheaper than a reader wondering why the check is
    // one-directional.
    const bodiless = new Set(
      fixtureFiles.flatMap((file) =>
        bodilessTitles(file).map((title) => `${file} › ${title}`),
      ),
    );
    const written = Object.keys(PENDING).filter((key) => !bodiless.has(key));
    for (const key of written) {
      const [file, title] = key.split(" › ");
      expect(
        titlesIn(`device/${file}`),
        `${key} is on the pending list with a written body, which is fine, but the test is gone`,
      ).toContain(title);
    }
  });
});
