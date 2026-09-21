import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The statement numbers a spec file defines: its ordered-list items, and the
 * `## N.` headings `findings.md` uses instead.
 *
 * The files cite each other by bare integer — "`findings.md` 8",
 * "`items.md` 5" — so nothing in a citation ties it to what it names.
 * Renumber a file, which the last sweep did to eight entries of
 * `findings.md`, and every citation still reads as a sentence while pointing
 * somewhere else, or nowhere at all. Neither the fixture checks in this file
 * nor any suite can see it: those resolve to fixture files and test titles,
 * and this is a reference between two documents.
 */
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

function statementNumbers(file: string): Set<number> {
  const text = readFileSync(resolve(specDir, file), "utf8");
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
 * same claim and were read by two patterns that disagreed about how many
 * numbers a citation has.
 *
 * A citation names as many statements as it lists, so "`items.md` 1, 2 and
 * 3" is three references rather than one, and every number in the list is
 * held to a statement that exists. A range is the exception it cannot
 * cover: "17 to 23" yields 17 and 23, and what sits between them is
 * whatever the writer meant.
 */
const CITED_STATEMENTS =
  /`([a-z][a-z-]*\.md)`\s+((?:\d+(?:\s*(?:,|and|to)\s*)?)+)/g;

/** Every `<file>.md <N>` reference in `spec/`, with where it was written. */
function statementCitations(): {
  spec: string;
  target: string;
  entry: number;
}[] {
  const out: { spec: string; target: string; entry: number }[] = [];
  for (const name of readdirSync(specDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(resolve(specDir, name), "utf8");
    for (const match of text.matchAll(CITED_STATEMENTS)) {
      for (const raw of match[2].match(/\d+/g) ?? []) {
        out.push({ spec: name, target: match[1], entry: Number(raw) });
      }
    }
  }
  return out;
}

function citations(): Citation[] {
  const out: Citation[] = [];
  for (const name of readdirSync(specDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(resolve(specDir, name), "utf8");
    for (const match of text.matchAll(
      /`((?:correctness|compliance|device|sync)\/[a-z0-9./-]+\.test\.ts)(?: › ([^`]+))?`/g,
    )) {
      out.push({ spec: name, file: match[1], title: match[2] });
    }
    // Shorthand: a `› title` following a citation continues the same file.
    for (const match of text.matchAll(
      /`((?:correctness|compliance|device|sync)\/[a-z0-9./-]+\.test\.ts) › [^`]+`(?:, `› ([^`]+)`)+/g,
    )) {
      const file = match[1];
      for (const cont of match[0].matchAll(/`› ([^`]+)`/g)) {
        out.push({ spec: name, file, title: cont[1] });
      }
    }
  }
  return out;
}

function titlesIn(file: string): string[] {
  const text = readFileSync(resolve(suitesDir, file), "utf8");
  return [
    ...text.matchAll(
      /(?:^|\s)(?:it|describe|it\.each\([^)]*\))\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g,
    ),
  ].map((m) => (m[1] ?? m[2]).replace(/\\`/g, "`"));
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
    const numbered = [...statementNumbers("findings.md")].sort((a, b) => a - b);
    // The positive control: the headings parsed at all.
    expect(numbered.length).toBeGreaterThan(5);
    expect(numbered).toEqual(numbered.map((_, index) => index + 1));
  });

  it("every numbered cross-reference names a statement that exists", () => {
    const cited = statementCitations();
    // The positive control. A zero count would pass the assertion below for
    // the wrong reason, and these are read out of prose by a regex that has
    // to keep matching.
    expect(cited.length).toBeGreaterThan(20);
    const defined = new Map<string, Set<number>>();
    const dangling: string[] = [];
    for (const { spec, target, entry } of cited) {
      if (!existsSync(resolve(specDir, target))) {
        dangling.push(`${spec}: ${target} (no such file)`);
        continue;
      }
      const numbers = defined.get(target) ?? statementNumbers(target);
      defined.set(target, numbers);
      if (!numbers.has(entry)) {
        dangling.push(`${spec}: ${target} ${String(entry)}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  /**
   * The same check, over the code that cites the chapters.
   *
   * There are more citations in Rust comments and in the fixtures than in
   * the chapters themselves, and nothing looked at any of them. A comment
   * citing a statement number reads as authority — it is how the next
   * person finds the rule a piece of code exists for — so one that resolves
   * to nothing, or to a chapter with fewer statements than it names, sends
   * them somewhere else entirely.
   *
   * This catches a number that does not exist. It cannot catch a number
   * that exists and is the wrong one; that needs a reader, and one was how
   * `device.md` 21's citation of `queue-and-verdicts.md` 14 was found.
   */
  it("every citation in the code names a statement that exists", () => {
    const sources = [
      ...walk(resolve(root, "..", "core", "marfa-core", "src"), ".rs"),
      ...walk(resolve(root, "..", "core", "marfa-cli", "src"), ".rs"),
      ...walk(resolve(root, "src"), ".ts"),
    ];
    const defined = new Map<string, Set<number>>();
    const dangling: string[] = [];
    let counted = 0;
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const found of text.matchAll(CITED_STATEMENTS)) {
        const target = found[1];
        if (!existsSync(resolve(specDir, target))) {
          dangling.push(`${file}: ${target} (no such chapter)`);
          continue;
        }
        const numbers = defined.get(target) ?? statementNumbers(target);
        defined.set(target, numbers);
        for (const raw of found[2].match(/\d+/g) ?? []) {
          counted += 1;
          const entry = Number(raw);
          if (!numbers.has(entry)) {
            dangling.push(`${file}: ${target} ${raw}`);
          }
        }
      }
    }
    // The positive control. These are read out of comments by a regex, and
    // a zero count passes the assertion below for the wrong reason.
    expect(
      counted,
      "no citation was found in the code at all, so the assertion below is about nothing",
    ).toBeGreaterThan(50);
    expect(dangling).toEqual([]);
  });

  it("every cited title is a test or describe title in its file", () => {
    const cache = new Map<string, string[]>();
    const unresolved: string[] = [];
    for (const c of all) {
      if (!c.title || !existsSync(resolve(suitesDir, c.file))) continue;
      const titles = cache.get(c.file) ?? titlesIn(c.file);
      cache.set(c.file, titles);
      const wanted = c.title.replace(/\\`/g, "`");
      if (!titles.some((t) => t === wanted)) {
        unresolved.push(`${c.spec}: ${c.file} › ${c.title}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});
