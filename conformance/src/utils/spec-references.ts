import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SPEC_DIR,
  chapterNames,
  isChapterName,
  readChapter,
  withoutDefinitions,
  type Chapter,
} from "./spec-statements.js";

/**
 * References to the contract's statements, from the chapters and from
 * everything else in the repository. A statement is referred to by its ID
 * in code font, and by nothing else.
 */

/** A reference to an ID: one code span, `<chapter>/<slug>`. */
const ID_REFERENCE = /`([a-z][a-z-]*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g;

export interface SpecIndex {
  /** Every Markdown file in `spec/`, by file name. */
  files: Map<string, string>;
  /** The chapters, by name without `.md`. */
  chapters: Map<string, Chapter>;
  /** Every ID the chapters state. */
  ids: Set<string>;
}

export function indexOf(
  files: Record<string, string>,
  chapterStems?: readonly string[],
): SpecIndex {
  const chapters = new Map<string, Chapter>();
  const ids = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const stem = file.replace(/\.md$/, "");
    if (chapterStems !== undefined && !chapterStems.includes(stem)) continue;
    const chapter = readChapter(text);
    chapters.set(stem, chapter);
    for (const statement of chapter.statements) ids.add(statement.id);
  }
  return { files: new Map(Object.entries(files)), chapters, ids };
}

export function readIndex(specDir = SPEC_DIR): SpecIndex {
  const files: Record<string, string> = {};
  for (const name of readdirSync(specDir)) {
    if (name.endsWith(".md")) {
      files[name] = readFileSync(resolve(specDir, name), "utf8");
    }
  }
  const stems = Object.keys(files)
    .map((name) => name.slice(0, -".md".length))
    .filter(isChapterName);
  return indexOf(files, stems);
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** What one text cites, and which of it points at nothing. */
export interface Checked {
  /** How many references were read. */
  checked: number;
  problems: string[];
}

/**
 * Every ID reference in `text`, held to the statements that exist.
 *
 * A code-font `a/b` is read as a reference only where `a` is a chapter,
 * because it is as often a path, and only outside the places that define
 * one when `definitions` is `false`: a chapter's ID headings, and the fenced
 * examples in `README.md`.
 */
export function checkReferences(
  where: string,
  text: string,
  index: SpecIndex,
  options: { definitions: boolean } = { definitions: true },
): Checked {
  const problems: string[] = [];
  let checked = 0;
  const scanned = options.definitions ? text : withoutDefinitions(text);
  for (const found of scanned.matchAll(ID_REFERENCE)) {
    if (!index.chapters.has(found[1])) continue;
    checked += 1;
    const id = `${found[1]}/${found[2]}`;
    if (index.ids.has(id)) continue;
    problems.push(
      `${where} line ${String(lineOf(scanned, found.index))}: \`${id}\` (no such statement)`,
    );
  }
  return { checked, problems };
}

/**
 * The ways a statement used to be referred to by number: a chapter's file
 * name and a number (`<chapter>.md 5`, in code font or not, perhaps with
 * the word statement between them), a chapter's name and a number in
 * parentheses, and the word statement and a number.
 */
function numberedPatterns(chapters: readonly string[]): RegExp[] {
  const names = chapters.map((name) => name.replace(/-/g, "\\-")).join("|");
  return [
    new RegExp(
      `\\b(?:${names})\\.md\`?(?:'s)?[ \\t]+(?:(?:statement|rule)s?[ \\t]+)?\\d`,
    ),
    new RegExp(`\\(\`?(?:${names})(?:\\.md)?\`?[ \\t]+\\d`),
    /\bstatements?[ \t]+\d/i,
  ];
}

/** What opens a line of a comment, read as a gap. */
const LINE_MARKER = /^\s*(?:\/\/[/!]?|\/?\*+|#+|--|<!--)?\s*/;

/** A list item, whose number or mark is the list's, not a statement's. */
const LIST_ITEM = /^(?:\d+[.)]|[-+])\s/;

/**
 * The lines of `text` that refer to a statement by number, 1-based. The
 * chapters are the ones the contract has, so a file that names another
 * Markdown file and a number is not read as a reference. A reference wrapped
 * onto the next line is read too, with that line's comment marker taken off,
 * and is named by the line it starts on.
 */
export function numberedReferences(
  text: string,
  chapters: readonly string[] = chapterNames(),
): number[] {
  const patterns = numberedPatterns(chapters);
  const refers = (line: string) =>
    patterns.some((pattern) => pattern.test(line));
  const lines = text.split("\n");
  const out: number[] = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    if (refers(line)) {
      out.push(index + 1);
      return;
    }
    if (next === undefined || refers(next)) return;
    const continued = next.replace(LINE_MARKER, "");
    if (LIST_ITEM.test(continued)) return;
    const joined = `${line.trimEnd()} ${continued}`;
    if (refers(joined)) out.push(index + 1);
  });
  return out;
}

/** The repository's root, from this file. */
export const REPOSITORY_ROOT = resolve(SPEC_DIR, "..", "..");

/**
 * Every file Git tracks in the repository that reads as text, by path from
 * its root. Read from Git rather than by walking the tree, so what a
 * checkout ignores, such as dependencies, build output and other worktrees,
 * is never read.
 */
export function trackedTextFiles(
  root = REPOSITORY_ROOT,
): { path: string; text: string }[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out: { path: string; text: string }[] = [];
  for (const path of listed.split("\0")) {
    if (path === "") continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(root, path));
    } catch {
      // Listed by Git and deleted in the working tree.
      continue;
    }
    if (bytes.includes(0)) continue;
    out.push({ path, text: bytes.toString("utf8") });
  }
  return out;
}
