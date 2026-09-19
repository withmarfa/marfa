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
function statementNumbers(file: string): Set<number> {
  const text = readFileSync(resolve(specDir, file), "utf8");
  const out = new Set<number>();
  for (const match of text.matchAll(/^(?:## )?(\d+)\. /gm)) {
    out.add(Number(match[1]));
  }
  return out;
}

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
    for (const match of text.matchAll(/`([a-z][a-z-]*\.md)`\s+(\d+)/g)) {
      out.push({ spec: name, target: match[1], entry: Number(match[2]) });
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
    expect(numbered.length).toBeGreaterThan(10);
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
