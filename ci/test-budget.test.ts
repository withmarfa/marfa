/**
 * Every project that has tests runs them on a budget somebody chose.
 *
 * Neither a project matched by the root config's `packages/*` glob nor the
 * inline `ci-config` project inherits the root `test` block's timeouts, so a
 * project without its own runs on Vitest's stock budget. That is not a
 * failure anyone sees as one: it surfaces as a timeout on a busy machine, in
 * a file the change under test never touched.
 *
 * **A green suite cannot catch a recurrence.** A new package with no config,
 * or a config that sets `name` and `include` and no budget, is green on a
 * quiet machine and stays green until the day something else is running.
 *
 * ## Why it resolves the config rather than reading it as text
 *
 * Having a config file is not having a budget, and a check that reasons from
 * the presence of a file, or from grepping for the word `testTimeout`, passes
 * on a config that sets only `name` and `include`. Importing the config and
 * reading the resolved number cannot be satisfied by a file that merely looks
 * right, and it follows the spread of `sharedTestBudget` without knowing that
 * is how the value arrives.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = "packages";

/** Packages holding at least one test file, so the ones a budget applies to. */
function testedPackages(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => hasTests(join(PACKAGES_DIR, name, "src")))
    .sort();
}

function hasTests(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasTests(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

async function resolvedTestOptions(
  pkg: string,
): Promise<Record<string, unknown>> {
  const path = resolve(PACKAGES_DIR, pkg, "vitest.config.ts");
  // A package with no config at all is already reported by the assertion
  // above, by name. Returning empty rather than letting the import throw
  // keeps this assertion's own message readable instead of burying it under
  // a module-resolution stack.
  if (!existsSync(path)) return {};
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(path).href
  )) as {
    default?: { test?: Record<string, unknown> };
  };
  return module.default?.test ?? {};
}

describe("every package runs its tests on a chosen budget", () => {
  it("finds the packages it is meant to be checking", () => {
    // Without this the whole file passes by matching nothing, which is the
    // failure mode it exists to prevent in the packages themselves.
    const packages = testedPackages();
    expect(packages.length).toBeGreaterThanOrEqual(4);
    // A rename that hides a known package from this list should redden here
    // rather than quietly shrink the check.
    expect(packages).toContain("server");
    expect(packages).toContain("types");
  });

  it("gives every tested package a vitest config of its own", () => {
    for (const pkg of testedPackages()) {
      expect(
        existsSync(join(PACKAGES_DIR, pkg, "vitest.config.ts")),
        `packages/${pkg} has tests but no vitest.config.ts, so it runs on Vitest's stock budget — the root config cannot reach it`,
      ).toBe(true);
    }
  });

  it("sets an explicit test and hook budget in each of them", async () => {
    for (const pkg of testedPackages()) {
      const options = await resolvedTestOptions(pkg);
      for (const key of ["testTimeout", "hookTimeout"] as const) {
        expect(
          typeof options[key],
          `packages/${pkg} does not resolve a ${key}, so it runs on Vitest's stock budget — spread sharedTestBudget from vitest.shared.ts, or choose a number here and say why`,
        ).toBe("number");
      }
    }
  });
});

describe("the ci-config project runs on a chosen budget", () => {
  it("sets an explicit test and hook budget in its inline block", async () => {
    const root = (await import(
      /* @vite-ignore */ pathToFileURL(resolve("vitest.config.ts")).href
    )) as {
      default: {
        test?: { projects?: (string | { test?: Record<string, unknown> })[] };
      };
    };
    const project = (root.default.test?.projects ?? []).find(
      (entry) => typeof entry === "object" && entry.test?.name === "ci-config",
    );
    expect(project, "the inline ci-config project").toBeDefined();
    const options = typeof project === "object" ? (project.test ?? {}) : {};
    for (const key of ["testTimeout", "hookTimeout"] as const) {
      expect(typeof options[key], `ci-config does not set ${key}`).toBe(
        "number",
      );
    }
  });
});
