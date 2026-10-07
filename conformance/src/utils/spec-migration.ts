import { citationsInText } from "./spec-statements.js";

/**
 * Moving the references to a chapter's numbered statements to the IDs that
 * replaced them. The functions here are pure: they take the text of a file
 * and say what to change in it. `scripts/spec-ids.ts` reads and writes the
 * files.
 */

/** A chapter's old numbers and the IDs that replaced them. */
export type Migration = Record<string, string[]>;

export type SiteKind =
  /** A chapter's name in code font and the numbers after it. */
  | "citation"
  /** The same with no code font, as a sentence in a comment writes it. */
  | "plain"
  /** A bare `(N)` inside the chapter's own file. */
  | "own-parenthesis"
  /** The word statement and a number inside the chapter's own file. */
  | "own-statement";

export interface Site {
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based, in characters from the start of the line. */
  column: number;
  original: string;
  kind: SiteKind;
  /** The old numbers the reference names, ranges included whole. */
  numbers: number[];
  proposed: string;
  needs_choice: boolean;
  /** Why a person has to choose. */
  reasons: string[];
  /** What the person chose: the replacement text, or the IDs to write. */
  choice?: string | string[];
}

/** A range that expands past this many IDs is a person's to write. */
export const RANGE_LIMIT = 4;

const GAP = String.raw`(?:[ \t]+|[ \t]*\r?\n[ \t]*(?:\*|///?|//!|#|>)?[ \t]*)`;
const SEPARATOR = String.raw`(?:(?:${GAP})?,(?:${GAP})?(?:(?:and|to)${GAP})?|${GAP}(?:and|to)${GAP})`;
const NUMBER = String.raw`\d+\b(?!\.\d)`;
const NUMBER_LIST = String.raw`${NUMBER}(?:${SEPARATOR}${NUMBER})*`;
const SHORT_SEPARATOR = String.raw`(?:, ?| and | to )`;

function patterns(chapter: string): {
  citation: RegExp;
  plain: RegExp;
  parenthesis: RegExp;
  statement: RegExp;
} {
  const name = chapter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    citation: new RegExp(
      String.raw`\`(?:[\w./-]*/)?${name}\.md\`${GAP}(${NUMBER_LIST})`,
      "g",
    ),
    plain: new RegExp(
      String.raw`(?<![\w\`/.-])(?:[\w.-]+/)*${name}\.md${GAP}(${NUMBER_LIST})`,
      "g",
    ),
    parenthesis: new RegExp(
      String.raw`\((${NUMBER}(?:${SHORT_SEPARATOR}${NUMBER})*)\)`,
      "g",
    ),
    statement: new RegExp(
      String.raw`\b[Ss]tatements?[ \t]+(${NUMBER}(?:${SHORT_SEPARATOR}${NUMBER})*)`,
      "g",
    ),
  };
}

/**
 * The numbers a list names, each with whether it ends a range, as written:
 * "3, 5 to 8 and 10" is 3, the range 5 to 8, and 10.
 */
export function numberItems(
  list: string,
): { from: number; to: number; range: boolean }[] {
  const items: { from: number; to: number; range: boolean }[] = [];
  let pending: number | undefined;
  let rangeFrom: number | undefined;
  for (const token of list.matchAll(/(\d+)|\bto\b/g)) {
    if (token[1] === undefined) {
      rangeFrom = pending;
      continue;
    }
    const number = Number(token[1]);
    if (rangeFrom !== undefined) {
      items.pop();
      items.push({ from: rangeFrom, to: number, range: true });
      rangeFrom = undefined;
    } else {
      items.push({ from: number, to: number, range: false });
    }
    pending = number;
  }
  return items;
}

/** The IDs a list of numbers moved to, in order, once each. */
export function expand(
  list: string,
  migration: Migration,
): { ids: string[]; unmapped: number[]; reasons: string[] } {
  const ids: string[] = [];
  const unmapped: number[] = [];
  const reasons: string[] = [];
  for (const item of numberItems(list)) {
    const rangeIds = new Set<string>();
    for (let n = item.from; n <= item.to; n++) {
      const mapped = migration[String(n)];
      if (mapped === undefined) {
        unmapped.push(n);
        continue;
      }
      if (mapped.length > 1) {
        reasons.push(
          `${String(n)} maps to ${String(mapped.length)} IDs, and which one is meant is a reading`,
        );
      }
      for (const id of mapped) {
        rangeIds.add(id);
        if (!ids.includes(id)) ids.push(id);
      }
    }
    if (item.range && rangeIds.size > RANGE_LIMIT) {
      reasons.push(
        `${String(item.from)} to ${String(item.to)} expands to ${String(rangeIds.size)} IDs, more than ${String(RANGE_LIMIT)}`,
      );
    }
  }
  for (const n of unmapped) {
    reasons.push(`${String(n)} is not in the migration`);
  }
  return { ids, unmapped, reasons };
}

/** IDs in code font as a sentence lists them: `a`, `b` and `c`. */
export function listIds(ids: readonly string[]): string {
  const quoted = ids.map((id) => `\`${id}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Every reference to `chapter`'s numbers in one file, with the text that
 * would replace it.
 *
 * A bare `(N)` and the word statement before a number mean the chapter's
 * own numbers only inside its own file, so `own` says whether `file` is it.
 * A reference written over a line end is read, and in a Markdown file one
 * whose number then starts a line as an ordered-list item is left to a
 * person, because the list item and the reference cannot be told apart.
 */
export function findSites(
  file: string,
  text: string,
  chapter: string,
  migration: Migration,
  own: boolean,
): Site[] {
  const found = patterns(chapter);
  const sites: Site[] = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) =>
    taken.some(([a, b]) => start < b && a < end);
  const add = (
    kind: SiteKind,
    start: number,
    original: string,
    list: string,
  ) => {
    const end = start + original.length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    const before = text.slice(0, start);
    const line = before.split("\n").length;
    const column = start - (before.lastIndexOf("\n") + 1);
    const { ids, reasons } = expand(list, migration);
    if (kind === "plain") reasons.push("the reference is plain text");
    if (
      /\n/.test(original) &&
      file.endsWith(".md") &&
      new RegExp(String.raw`\n[ \t]*${NUMBER}\.[ \t]`).test(
        text.slice(start + original.lastIndexOf("\n"), end + 2),
      )
    ) {
      reasons.push("the number may start a list item");
    }
    const listed = listIds(ids);
    sites.push({
      file,
      line,
      column,
      original,
      kind,
      numbers: [
        ...new Set(
          numberItems(list).flatMap((item) =>
            Array.from(
              { length: item.to - item.from + 1 },
              (_, i) => item.from + i,
            ),
          ),
        ),
      ],
      proposed: kind === "own-parenthesis" ? `(${listed})` : listed,
      needs_choice: reasons.length > 0,
      reasons,
    });
  };
  for (const match of text.matchAll(found.citation)) {
    add("citation", match.index, match[0], match[1]);
  }
  for (const match of text.matchAll(found.plain)) {
    add("plain", match.index, match[0], match[1]);
  }
  if (own) {
    for (const match of text.matchAll(found.parenthesis)) {
      add("own-parenthesis", match.index, match[0], match[1]);
    }
    for (const match of text.matchAll(found.statement)) {
      add("own-statement", match.index, match[0], match[1]);
    }
  }
  return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The text a site is rewritten to: the person's choice, else the proposal. */
export function replacement(site: Site): string {
  if (site.choice === undefined) return site.proposed;
  if (typeof site.choice === "string") return site.choice;
  const listed = listIds(site.choice);
  return site.kind === "own-parenthesis" ? `(${listed})` : listed;
}

/**
 * The sites, as `file:line`, that name a number the map has no entry for:
 * a decisions file made from a map that has since changed.
 */
export function outOfMap(
  sites: readonly Site[],
  migration: Migration,
): string[] {
  return sites
    .filter((site) =>
      site.numbers.some((number) => migration[String(number)] === undefined),
    )
    .map((site) => `${site.file}:${String(site.line)}`);
}

/** The sites that wait on a person, as `file:line` for a message. */
export function unchosen(sites: readonly Site[]): string[] {
  return sites
    .filter((site) => site.needs_choice && site.choice === undefined)
    .map((site) => `${site.file}:${String(site.line)}`);
}

/**
 * `text` with the sites that belong to it rewritten. A site is found again
 * by its line, its column and the text it had, so a file that changed since
 * the plan was made is refused and not rewritten at the wrong place.
 */
export function rewrite(text: string, sites: readonly Site[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  let out = text;
  const located = sites
    .map((site) => ({
      site,
      offset: (starts[site.line - 1] ?? NaN) + site.column,
    }))
    .sort((a, b) => b.offset - a.offset);
  for (const { site, offset } of located) {
    if (!text.startsWith(site.original, offset)) {
      throw new Error(
        `${site.file}:${String(site.line)} no longer reads as planned; make the plan again`,
      );
    }
    out =
      out.slice(0, offset) +
      replacement(site) +
      out.slice(offset + site.original.length);
  }
  return out;
}

/**
 * The fixture citations a chapter makes before and not after, as `file ›
 * title`. A chapter moved to IDs asserts everything it asserted, so any
 * that is gone is a rule that lost its test.
 */
export function droppedCitations(before: string, after: string): string[] {
  const key = (c: { file: string; title?: string }) =>
    `${c.file} › ${c.title ?? ""}`;
  const kept = new Set(citationsInText(after).map(key));
  return [...new Set(citationsInText(before).map(key))].filter(
    (citation) => !kept.has(citation),
  );
}
