import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every citation in `spec/` must name a fixture that exists: a file under
 * `src/suites/` and, when a title is given, a test or describe title in it.
 * A statement whose citation does not resolve is a statement nothing asserts.
 */

const root = resolve(process.cwd());
const specDir = resolve(root, "spec");
const suitesDir = resolve(root, "src/suites");

interface Citation {
  spec: string;
  file: string;
  title?: string;
}

function citations(): Citation[] {
  const out: Citation[] = [];
  for (const name of readdirSync(specDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(resolve(specDir, name), "utf8");
    for (const match of text.matchAll(
      /`((?:correctness|compliance|sync)\/[a-z0-9./-]+\.test\.ts)(?: › ([^`]+))?`/g,
    )) {
      out.push({ spec: name, file: match[1], title: match[2] });
    }
    // Shorthand: a `› title` following a citation continues the same file.
    for (const match of text.matchAll(
      /`((?:correctness|compliance|sync)\/[a-z0-9./-]+\.test\.ts) › [^`]+`(?:, `› ([^`]+)`)+/g,
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
