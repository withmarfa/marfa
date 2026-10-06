import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEC_DIR,
  chapterIds,
  isChapterName,
  readChapter,
  withoutDefinitions,
  type Chapter,
} from "./spec-statements.js";
import type { Migration } from "./spec-migration.js";

/**
 * References between the chapters and from the code to them, in both forms
 * a statement is cited: a chapter's name and a number while the chapter is
 * numbered, and its ID once it is not.
 */

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spec-migrations",
);

export type { Migration };

/**
 * The statement numbers `text` defines: its ordered-list items, and the
 * `## N.` headings `findings.md` uses instead.
 *
 * The files cite each other by chapter name and bare integer, so nothing in
 * a citation ties it to what it names. Renumber a file and every citation
 * still reads as a sentence while pointing somewhere else, or nowhere at
 * all. Neither the fixture checks nor any suite can see it: those resolve
 * to fixture files and test titles, and this is a reference between two
 * documents.
 */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const match of text.matchAll(/^(?:## )?(\d+)\. /gm)) {
    out.add(Number(match[1]));
  }
  return out;
}

/**
 * A citation and every statement number it names.
 *
 * One expression for the chapters and for the sources, because a citation
 * written in a chapter and the same citation written in a comment are the
 * same claim.
 *
 * A citation names as many statements as it lists, so a chapter name
 * followed by "1, 2 and 3" is three references rather than one, and every
 * number in the list is held to a statement that exists. A range is the
 * exception it cannot cover: "17 to 23" yields 17 and 23, and what sits
 * between them is whatever the writer meant. The tests of these checks are
 * inside the source walk, so none of them writes a chapter name in code
 * font followed by a number or an ID.
 *
 * The gap between the name and the first number is spaces on one line,
 * never a newline: a chapter name that ends a line above an ordered-list
 * item is not citing that item's number.
 */
export const CITED_STATEMENTS =
  /`([a-z][a-z-]*\.md)`[ \t]+((?:\d+(?:\s*(?:,|and|to)\s*)?)+)/g;

/** A reference to an ID: one code span, `<chapter>/<slug>`. */
const ID_REFERENCE = /`([a-z][a-z-]*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g;

export interface SpecIndex {
  /** Every Markdown file in `spec/`, by file name. */
  files: Map<string, string>;
  /** The chapters, by name without `.md`. */
  chapters: Map<string, Chapter>;
  /** Every active ID. */
  active: Set<string>;
  /** Every retired ID with what replaced it. */
  retired: Map<string, string[]>;
  migrations: Map<string, Migration>;
}

export function indexOf(
  files: Record<string, string>,
  migrations: Record<string, Migration> = {},
  chapterStems?: readonly string[],
): SpecIndex {
  const chapters = new Map<string, Chapter>();
  const active = new Set<string>();
  const retired = new Map<string, string[]>();
  for (const [file, text] of Object.entries(files)) {
    const stem = file.replace(/\.md$/, "");
    if (chapterStems !== undefined && !chapterStems.includes(stem)) continue;
    const chapter = readChapter(stem, text);
    chapters.set(stem, chapter);
    const ids = chapterIds(chapter);
    for (const id of ids.active) active.add(id);
    for (const entry of chapter.retired)
      retired.set(entry.id, entry.replacedBy);
  }
  return {
    files: new Map(Object.entries(files)),
    chapters,
    active,
    retired,
    migrations: new Map(Object.entries(migrations)),
  };
}

export function readMigrations(
  dir = MIGRATIONS_DIR,
): Record<string, Migration> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        name.slice(0, -".json".length),
        JSON.parse(readFileSync(resolve(dir, name), "utf8")) as Migration,
      ]),
  );
}

export function readIndex(
  specDir = SPEC_DIR,
  migrationsDir = MIGRATIONS_DIR,
): SpecIndex {
  const files: Record<string, string> = {};
  for (const name of readdirSync(specDir)) {
    if (name.endsWith(".md")) {
      files[name] = readFileSync(resolve(specDir, name), "utf8");
    }
  }
  const stems = Object.keys(files)
    .map((name) => name.slice(0, -".md".length))
    .filter(isChapterName);
  return indexOf(files, readMigrations(migrationsDir), stems);
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** What one text cites, and which of it points at nothing. */
export interface Checked {
  /** How many references were read, numbered and ID together. */
  checked: number;
  problems: string[];
}

/**
 * Every statement reference in `text`, held to the statements that exist.
 *
 * A number into a chapter written in the ID form fails, and the failure names
 * the IDs that replaced it when `spec-migrations/<chapter>.json` says. An ID
 * is read only where its chapter is written in the ID form, because a
 * code-font `a/b` is as often a path as a reference, and only outside the
 * places that define one when `definitions` is `false`: a chapter's
 * headings and Retired list, and the fenced examples in `README.md`.
 */
export function checkReferences(
  where: string,
  text: string,
  index: SpecIndex,
  options: { definitions: boolean } = { definitions: true },
): Checked {
  const problems: string[] = [];
  let checked = 0;
  for (const found of text.matchAll(CITED_STATEMENTS)) {
    const target = found[1];
    const line = lineOf(text, found.index);
    if (!index.files.has(target)) {
      problems.push(`${where} line ${String(line)}: ${target} (no such file)`);
      checked += (found[2].match(/\d+/g) ?? []).length;
      continue;
    }
    const chapter = index.chapters.get(target.replace(/\.md$/, ""));
    const numbers = numbersIn(index.files.get(target) ?? "");
    for (const raw of found[2].match(/\d+/g) ?? []) {
      checked += 1;
      if (numbers.has(Number(raw))) continue;
      const moved = chapter?.form === "id";
      const replacement = index.migrations.get(target.replace(/\.md$/, ""))?.[
        raw
      ];
      problems.push(
        `${where} line ${String(line)}: ${target} ${raw}` +
          (moved
            ? replacement === undefined
              ? " (the chapter now states its rules by ID, and spec-migrations names none for this number)"
              : ` (the chapter now states its rules by ID: ${replacement
                  .map((id) => `\`${id}\``)
                  .join(", ")})`
            : ""),
      );
    }
  }
  const scanned = options.definitions ? text : withoutDefinitions(text);
  for (const found of scanned.matchAll(ID_REFERENCE)) {
    const chapter = index.chapters.get(found[1]);
    if (chapter?.form !== "id" && chapter?.form !== "mixed") continue;
    checked += 1;
    const id = `${found[1]}/${found[2]}`;
    if (index.active.has(id)) continue;
    const line = lineOf(scanned, found.index);
    const replacedBy = index.retired.get(id);
    problems.push(
      `${where} line ${String(line)}: \`${id}\` ` +
        (replacedBy === undefined
          ? "(no such statement)"
          : replacedBy.length === 0
            ? "(retired)"
            : `(retired, replaced by ${replacedBy.map((r) => `\`${r}\``).join(", ")})`),
    );
  }
  return { checked, problems };
}
