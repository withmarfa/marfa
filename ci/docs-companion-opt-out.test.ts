/**
 * The docs gate's opt-out must be a line somebody wrote as an opt-out.
 *
 * The gate fails a pull request that touches a documented surface without a
 * docs companion, and offers an escape hatch: a `docs: n/a` line in the body.
 * The hatch was matched unanchored and multiline, so **any** line beginning
 * that way opened it — a pasted commit-log excerpt, a sentence whose first
 * words happened to be `docs: none of the below`, or a `docs: skip` sitting
 * inside a fenced code block.
 *
 * ## Why this is the direction worth a test
 *
 * The gate's two failure modes are not symmetric. Demanding docs for a change
 * that needs none is noisy, visible, and self-correcting — somebody types the
 * opt-out. Letting a real surface change through undocumented is silent, and
 * the docs drift without anybody learning that they have. **Only the second
 * one is bought by loosening the pattern**, and only the second one is
 * invisible in a green run.
 *
 * ## Why the pattern is read out of the workflow rather than copied here
 *
 * A copy is a second thing to keep in step, and the failure it invites is the
 * one where the test passes against a pattern the workflow no longer uses.
 * The regex is extracted from the YAML and exercised as the shipped literal,
 * so editing the workflow is what this file is judging.
 *
 * ## The case that is easy to get wrong in the safe-looking direction
 *
 * Anchoring with `$` alone breaks every genuine opt-out. Pull request bodies
 * arrive CRLF-delimited, and JavaScript's `$` under `m` matches before `\n`
 * but not before `\r` — so a tightened pattern without `\r?` would refuse the
 * waiver on every waived pull request. That is a false positive rather than a
 * false negative, so it is the cheaper mistake, but it is still a broken gate
 * and nothing else would catch it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = join(repoRoot, ".github", "workflows", "docs-companion.yml");

/**
 * Turn a source-text regex literal into a live one.
 *
 * The empty string is unreachable — every caller asserts the match first —
 * but `expect(...).toBeDefined()` does not narrow a type, so the throw is
 * what makes this total rather than a non-null assertion that would hide a
 * genuine extraction failure behind a confusing error.
 */
function compile(literalText: string): RegExp {
  const lastSlash = literalText.lastIndexOf("/");
  if (lastSlash < 1) {
    throw new Error(`not a regex literal: ${JSON.stringify(literalText)}`);
  }
  return new RegExp(
    literalText.slice(1, lastSlash),
    literalText.slice(lastSlash + 1),
  );
}

/** Pull a named regex literal out of the workflow's inline script. */
function literal(name: string): RegExp {
  const text = readFileSync(workflow, "utf8");
  // Two shapes are in use: a bare literal assigned across a line break, and
  // one inside a single-argument arrow. Both are matched rather than one,
  // because a rewrite from either shape to the other is a refactor nobody
  // would think to mention, and a test that silently stops recognizing its
  // subject is worse than no test.
  const assignment = new RegExp(
    `const\\s+${name}\\s*=\\s*(?:\\([^)]*\\)\\s*=>\\s*)?\\s*(/[^\\n]*?/[a-z]*)\\.test\\(`,
  ).exec(text);
  expect(
    assignment?.[1],
    `\`${name}\` is no longer a regex literal tested against a string in ` +
      `${workflow}. This file judges the shipped pattern, so it cannot ` +
      `report on a shape it does not recognize — it must not pass over it.`,
  ).toBeDefined();
  return compile(assignment?.[1] ?? "");
}

describe("the docs gate reads the workflow it is about", () => {
  it("finds the file and both patterns", () => {
    // A rule-checking test that matches nothing reports a confident pass.
    expect(existsSync(workflow), `${workflow} is missing`).toBe(true);
    expect(literal("hasOptOutLine")).toBeInstanceOf(RegExp);
    expect(literal("isTest")).toBeInstanceOf(RegExp);
  });
});

describe("the opt-out opens only for a line written as one", () => {
  // Both halves come out of the workflow: the fence strip, and — this is the
  // half a first attempt got wrong — *whether the opt-out is tested against
  // the stripped text at all*. Stripping fences in the test and then matching
  // is a pipeline the test invented; it stays green when the workflow drops
  // the strip, which is precisely the regression worth catching. So the
  // variable the workflow passes to `.test(` is read too, and the table below
  // only means anything because of it.
  const stripFences = (): RegExp => {
    const text = readFileSync(workflow, "utf8");
    const m = /const prose = body\.replace\((\/.*?\/[a-z]*), ""\);/.exec(text);
    expect(
      m?.[1],
      "the workflow no longer derives a fence-stripped `prose` from the body",
    ).toBeDefined();
    return compile(m?.[1] ?? "");
  };

  it("matches the opt-out against the fence-stripped text, not the raw body", () => {
    const text = readFileSync(workflow, "utf8");
    const arg =
      /hasOptOutLine\s*=\s*\n?\s*\/.*\/[a-z]*\.test\(\s*\n?\s*([A-Za-z_$][\w$]*)/.exec(
        text,
      )?.[1];
    expect(
      arg,
      "could not find what the opt-out is tested against, so this file " +
        "cannot report on it and must not pass over it",
    ).toBeDefined();
    expect(
      arg,
      "the opt-out is matched against the raw body, so a `docs: skip` " +
        "inside a fenced code example opens the gate on a pull request that " +
        "genuinely changed a documented surface",
    ).toBe("prose");
  });

  const optsOut = (body: string): boolean =>
    literal("hasOptOutLine").test(body.replace(stripFences(), ""));

  it.each([
    ["docs: n/a", "the plain form"],
    ["docs: na", "without the slash"],
    ["Docs: N/A", "case is not the reader's problem"],
    ["docs: none", "the second keyword"],
    ["docs: not required", "the third"],
    ["docs: skip", "the fourth"],
    ["  docs: skip", "indented, which a body often is"],
    ["Some summary.\n\ndocs: n/a", "on its own line after prose"],
    [
      "docs: n/a\r\nmore text",
      "CRLF, which is how bodies arrive — `$` handles it unaided, and this " +
        "case is here because it is natural to assume it does not",
    ],
    ["docs: n/a   ", "trailing spaces somebody did not see"],
  ])("opens for %j — %s", (body) => {
    expect(optsOut(body)).toBe(true);
  });

  it.each([
    [
      "## Changelog\ndocs: skip flaky retry test\n\nreal content",
      "a pasted commit-log line, which is the case that actually happened",
    ],
    [
      "Summary.\n\ndocs: none of the below need review, see appendix",
      "a sentence that merely opens with the keyword",
    ],
    [
      "Here is the config:\n\n```\ndocs: skip\n```\n",
      "inside a fenced code block",
    ],
    ["- docs: none needed", "a markdown bullet"],
    ["notes: see docs: skip section below", "mid-line rather than line-start"],
    ["docs: skipping this for now", "a keyword that is a prefix of a word"],
    ["docs:", "the keyword omitted entirely"],
    ["", "an empty body"],
  ])("stays shut for %j — %s", (body) => {
    expect(optsOut(body)).toBe(false);
  });
});

describe("a test file is not a documented surface", () => {
  const isTest = (f: string): boolean => literal("isTest").test(f);

  it.each([
    "packages/server/src/routes/items.test.ts",
    "packages/server/src/routes/items.test.tsx",
    "packages/server/src/routes/items.test.mts",
    "packages/server/src/routes/items.test.js",
    "packages/server/src/routes/items.integration.test.ts",
  ])("skips %s", (f) => {
    expect(isTest(f)).toBe(true);
  });

  it.each([
    "packages/server/src/routes/items.ts",
    "packages/server/src/routes/latest.ts",
    "packages/server/src/routes/test-utils.ts",
    "packages/server/src/routes/items.testing.ts",
    "packages/sync-manifest/src/manifest.ts",
  ])("still gates %s", (f) => {
    expect(isTest(f)).toBe(false);
  });

  it("gates a `.spec.` file rather than exempting it", () => {
    // The alternative spelling is deliberately absent. Nothing in this
    // repository is named that way, so it would exempt nothing real — while
    // `openapi.spec.ts` under a tracked prefix is a plausible name for
    // something that IS the surface. Gating a `.spec.` test that appears
    // later is the noisy, self-correcting direction.
    expect(isTest("packages/server/src/openapi/openapi.spec.ts")).toBe(false);
  });
});
