import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-package projects, matched as a directory glob.
    //
    // A project matched this way does not inherit anything from the `test`
    // block below. Vitest applies a root `test` block to inline projects
    // only — "projects referenced as external files or directories do not
    // inherit from the root config automatically" — so every package owns
    // its own budget, and every package now sets one from
    // `vitest.shared.ts`. This comment used to claim the opposite, and name
    // three packages as having no config of their own when `shared` had one;
    // the numbers below reached none of them, which is how seven packages
    // came to run on Vitest's stock 10s default.
    projects: [
      "packages/*",
      {
        // `ci/` holds tests over the repository's own CI configuration
        // rather than over any package, so the glob above cannot reach it
        // and it has no package.json to be discovered by. Named inline so
        // the whole project set is readable in one place. Not `.github/`:
        // a leading dot is skipped by the globber unless asked for, and a
        // test that silently matches nothing reports a confident pass.
        test: {
          name: "ci-config",
          include: ["ci/**/*.test.ts"],
        },
      },
    ],
    // These govern the inline `ci-config` project above and nothing else,
    // because an inline project is the only kind that inherits them. The
    // per-package budget lives in `vitest.shared.ts`, and `ci/test-budget.test.ts`
    // holds every package to having one.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
