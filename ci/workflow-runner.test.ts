/**
 * Every job runs on the pool, and nothing asks `setup-node` to cache pnpm.
 *
 * Both rules are stated in prose at the top of `ci.yml` and `core.yml`, and
 * prose is what a fourth workflow does not read. Neither rule fails visibly
 * when it is broken: a hosted fallback is green and bills ten times a Linux
 * minute for a macOS one, and a `cache: pnpm` on a runner that keeps its own
 * store restores nothing and then tars the whole store — measured in the tens
 * of gigabytes — in a post step, on a machine that is also running other
 * work. A green run is exactly what both look like.
 *
 * ## Why the runner is asserted as a literal
 *
 * `runs-on: self-hosted` and nothing else. An expression such as
 * `${{ vars.SOMETHING || 'ubuntu-latest' }}` is a hosted fallback wearing a
 * variable: it runs on GitHub's runners the moment the variable is unset or
 * misspelled, which is the failure this repository has decided it would
 * rather take as a queued job. A job waiting for a pool that is down is the
 * correct behavior.
 *
 * The cost is that a genuine change to either rule is a two-file change,
 * which is the intended friction.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

const RUNNER = "self-hosted";

const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

describe("every job runs on the pool", () => {
  it("finds the workflows, so an empty pass cannot be a missing directory", () => {
    // A rule-checking test that matches nothing reports a confident pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s names the pool and nothing else", (file) => {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const found = [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(found.length, `${file} declares no runs-on`).toBeGreaterThan(0);
    for (const value of found) expect(value).toBe(RUNNER);
  });
});

describe("no job asks setup-node to cache pnpm", () => {
  it("is reading workflows and finding setup-node in them", () => {
    const total = files
      .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
      .join("\n")
      .match(/actions\/setup-node/g);
    expect(total?.length ?? 0, "no setup-node step found").toBeGreaterThan(0);
  });

  it.each(files)("%s declares no cache under setup-node", (file) => {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    // `pnpm/action-setup` also takes a `cache` input, spells it in its own
    // `with:` block, and is not what tars the store; only setup-node's is
    // checked. Each block runs to the next step, which is the next line at
    // the same indent opening with `- `.
    const blocks = text.split(/uses:\s*actions\/setup-node/).slice(1);
    for (const block of blocks) {
      const found = /^\s*cache:\s*(.+)$/m.exec(block.split(/^\s*- /m)[0] ?? "");
      expect(
        found?.[1]?.trim(),
        `${file} sets a setup-node cache. The pool keeps its pnpm store ` +
          `between jobs, so the cache restores nothing and its post step ` +
          `tars the whole store on every run.`,
      ).toBeUndefined();
    }
  });
});
