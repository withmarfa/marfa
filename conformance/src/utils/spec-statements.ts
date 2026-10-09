import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one reader of a contract chapter: a level-3 heading holding one
 * code-font ID, then the rule, an optional reason and the tests. Every check
 * that reads statements reads them here, so no two of them can disagree
 * about what a statement is.
 */

export const SPEC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spec",
);

/** Files in `spec/` that hold no statements. */
const NOT_CHAPTERS = new Set(["README", "coverage"]);

/** One paragraph of a statement, with its label read off. */
export interface Paragraph {
  kind: "rule" | "reason" | "tests";
  /** The paragraph without its `**Reason:**` or `**Tests:**` label. */
  text: string;
  /** First and last line, 1-based. */
  line: number;
  end: number;
}

export interface Statement {
  id: string;
  rule: string;
  reason?: string;
  tests?: string;
  /** The line of the statement's heading, 1-based. */
  line: number;
  /** The statement's paragraphs in order, whatever their kind. */
  paragraphs: Paragraph[];
}

export interface Chapter {
  statements: Statement[];
  /** Headings the form has no place for, by line. */
  stray: number[];
}

/** The slug of an ID: lowercase words and digits joined by single hyphens. */
export const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;

/** Whether `id` is `<chapter>/<slug>` for this chapter, with a slug in grammar. */
export function isId(chapter: string, id: string): boolean {
  const prefix = `${chapter}/`;
  if (!id.startsWith(prefix)) return false;
  const slug = id.slice(prefix.length);
  return SLUG.test(slug) && slug.length <= SLUG_MAX;
}

/** What a statement's rule and tests say together, where its citations are. */
export function statementText(statement: Statement): string {
  return [statement.rule, statement.tests]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

const ID_HEADING = /^### `([^`]+)`\s*$/;
const HEADING = /^(#{1,6}) (.*?)\s*$/;
const FENCE = /^\s*```/;

export function readChapter(text: string): Chapter {
  const statements: Statement[] = [];
  const stray: number[] = [];
  let current: Statement | undefined;
  let open: { lines: string[]; line: number } | undefined;
  let fenced = false;

  const flush = (end: number) => {
    if (open !== undefined && current !== undefined) {
      const joined = open.lines.map((line) => line.trim()).join(" ");
      const labelled = /^\*\*(Reason|Tests):\*\*\s*(.*)$/.exec(joined);
      const kind =
        labelled === null
          ? "rule"
          : labelled[1] === "Reason"
            ? "reason"
            : "tests";
      const body = labelled === null ? joined : labelled[2];
      current.paragraphs.push({ kind, text: body, line: open.line, end });
      if (kind === "rule" && current.rule === "") current.rule = body;
      if (kind === "reason") current.reason ??= body;
      if (kind === "tests") current.tests ??= body;
    }
    open = undefined;
  };

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const number = index + 1;
    if (fenced || FENCE.test(line)) {
      if (FENCE.test(line)) fenced = !fenced;
      open ??= { lines: [], line: number };
      open.lines.push(line);
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush(number - 1);
      const level = heading[1].length;
      current = undefined;
      if (level <= 2) return;
      const code = ID_HEADING.exec(line);
      if (level === 3 && code !== null) {
        current = { id: code[1], rule: "", line: number, paragraphs: [] };
        statements.push(current);
      } else {
        stray.push(number);
      }
      return;
    }
    if (/^\s*$/.test(line)) {
      flush(number - 1);
      return;
    }
    open ??= { lines: [], line: number };
    open.lines.push(line);
  });
  flush(lines.length);
  return { statements, stray };
}

/**
 * The text with everything that defines a statement or shows the form
 * blanked out, line for line: the ID headings and fenced blocks. What is
 * left holds only references.
 */
export function withoutDefinitions(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (fenced || FENCE.test(line)) {
        if (FENCE.test(line)) fenced = !fenced;
        return "";
      }
      return ID_HEADING.test(line) ? "" : line;
    })
    .join("\n");
}

const CITATION_FILE =
  /^((?:correctness|compliance|device|sync|cli)\/[a-z0-9./-]+\.test\.ts)(?: › (.+))?$/;
const CITATION_CONTINUED = /^› (.+)$/;

/**
 * Every `file › title` the code spans of `text` cite, expanding the
 * `› title` shorthand, which continues the file of the span right before it
 * and only when a comma and a space are all that sit between them. A span
 * that cites something else in between, such as a test of the server's own,
 * ends the run, so a shorthand after it is not read as a fixture's.
 *
 * Read span by span rather than by splitting the sentence, because a test
 * title carries commas as readily as the prose around it does and a split
 * would cut one in half. A paragraph is one text: pass a paragraph and not
 * a file.
 */
export function citationsIn(text: string): { file: string; title?: string }[] {
  const out: { file: string; title?: string }[] = [];
  let file: string | undefined;
  let end = -1;
  for (const span of text.matchAll(/`([^`]+)`/g)) {
    const cited = CITATION_FILE.exec(span[1]);
    const continued = CITATION_CONTINUED.exec(span[1]);
    if (cited) {
      file = cited[1];
      out.push({ file, title: cited[2] });
    } else if (
      continued &&
      file !== undefined &&
      text.slice(end, span.index) === ", "
    ) {
      out.push({ file, title: continued[1] });
    } else {
      file = undefined;
    }
    end = span.index + span[0].length;
  }
  return out;
}

/** Every citation in a file's text, a paragraph at a time. */
export function citationsInText(
  text: string,
): { file: string; title?: string }[] {
  return text.split(/\n\s*\n/).flatMap((paragraph) => citationsIn(paragraph));
}

/** Whether a file stem names a chapter, as opposed to the files that hold no statements. */
export function isChapterName(stem: string): boolean {
  return !NOT_CHAPTERS.has(stem) && /^[a-z][a-z-]*$/.test(stem);
}

/** The chapters of the contract: the files in `dir` that hold statements. */
export function chapterNames(dir = SPEC_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter(isChapterName)
    .sort();
}

export function readChapters(dir = SPEC_DIR): Map<string, Chapter> {
  return new Map(
    chapterNames(dir).map((name) => [
      name,
      readChapter(readFileSync(resolve(dir, `${name}.md`), "utf8")),
    ]),
  );
}
