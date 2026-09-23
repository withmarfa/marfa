import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PENDING, PENDING, PENDING_BEYOND_MILESTONE } from "./pending.js";

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

function blocksIn(file: string): Array<{ title: string; source: string }> {
  const text = readFileSync(resolve(here, file), "utf8");
  const found: Array<{ title: string; source: string }> = [];
  for (const block of text.split(/(?=(?:^|\s)it\(\s*")/)) {
    TITLE.lastIndex = 0;
    const title = TITLE.exec(block);
    if (title) found.push({ title: title[1], source: block });
  }
  return found;
}

function blockFor(file: string, title: string): string | undefined {
  return blocksIn(file).find((block) => block.title === title)?.source;
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
});

describe("the pending list and the fixtures agree", () => {
  it("keeps what a later milestone covers out of the list this one empties", () => {
    // The reason is the entry, not a comment beside it. Milestone one is
    // reached when `PENDING` is empty, so a statement that moved here without
    // the decision that put it here would let the milestone be declared by
    // relabeling rather than by work. The device's blob work is the only
    // thing the milestone deliberately leaves — the server's has landed, and
    // these two are the device's half of it.
    expect(
      PENDING_BEYOND_MILESTONE,
      "a statement was moved out of the milestone's list without the decision that allows it, so the list the milestone must empty is shrinking by bookkeeping",
    ).toEqual({
      "working-copy.test.ts › holds the thumbnail an item carries":
        "device.md 29 — the device has no thumbnail at all: no shipped type carries thumbnail bytes, nothing under core/ names one, and the local row holds an item's properties alone, so there is nothing for hydration to carry and nothing for a read to answer with",
      "working-copy.test.ts › says the bytes are absent rather than the item":
        "device.md 30 — the device has no door that reads a blob: upload_blob is the one queued kind the drain refuses to address and no local read takes a hash, so nothing can be asked for bytes and there is no answer to hold to absent bytes rather than an absent item",
    });
  });

  it("keeps the two registers disjoint", () => {
    // A key in both merges into one union and the duplicate is invisible,
    // which would let an entry sit in `PENDING_BEYOND_MILESTONE` while
    // `PENDING` still counts it, or the reverse once one is removed.
    const inBoth = Object.keys(PENDING).filter(
      (key) => key in PENDING_BEYOND_MILESTONE,
    );
    expect(
      inBoth,
      "a fixture is on both registers, so removing it from one leaves it pending under the other and the milestone's list cannot be trusted to be complete",
    ).toEqual([]);
  });

  it("names a fixture that exists for every pending entry", () => {
    const missing = Object.keys(ALL_PENDING).filter((key) => {
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
    for (const [key, statement] of Object.entries(ALL_PENDING)) {
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
    const listed = new Set(Object.keys(ALL_PENDING));

    const unlisted = [...bodiless].filter((key) => !listed.has(key)).sort();
    expect(
      unlisted,
      "a fixture with no body is not on the pending list, so it fails as though the device were broken rather than reporting the statement it is waiting for",
    ).toEqual([]);
  });

  it("requires a written pending fixture to be the kind that polices itself", () => {
    // A pending fixture whose body is written has to run and fail, so the day
    // the device satisfies it the run goes red asking for the entry to be
    // removed. One that skips instead would sit on the list forever, cited by
    // a statement nothing asserts, with every other check here passing.
    const bodiless = new Set(
      fixtureFiles.flatMap((file) =>
        bodilessTitles(file).map((title) => `${file} › ${title}`),
      ),
    );
    const wrong: string[] = [];
    for (const key of Object.keys(ALL_PENDING)) {
      if (bodiless.has(key)) continue;
      const [file, title] = key.split(" › ");
      const block = blockFor(file, title);
      if (block === undefined) {
        wrong.push(`${key}: the test is gone`);
        continue;
      }
      if (!block.includes("pendingUntilItPasses(")) {
        wrong.push(
          `${key}: has a body but does not run it under pendingUntilItPasses`,
        );
      }
      if (block.includes("skipIfPending(")) {
        wrong.push(
          `${key}: has a body and skips anyway, so it can never go green`,
        );
      }
    }
    expect(
      wrong,
      "a pending fixture with a written body is not the self-policing kind, so a statement the device already satisfies can stay skipped forever",
    ).toEqual([]);
  });
});
