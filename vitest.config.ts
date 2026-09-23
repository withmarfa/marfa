import { defineConfig } from "vitest/config";
import { sharedTestBudget } from "./vitest.shared.js";

export default defineConfig({
  test: {
    // Per-package projects, matched as a directory glob. A project matched
    // this way inherits nothing from this file, so each package sets its
    // own budget from `vitest.shared.ts`.
    projects: [
      "packages/*",
      {
        // `ci/` holds tests over the repository's own CI configuration
        // rather than over any package, so the glob above cannot reach it
        // and it has no package.json to be discovered by. Named inline so
        // the whole project set is readable in one place. Not `.github/`:
        // a leading dot is skipped by the globber unless asked for, and a
        // test that silently matches nothing reports a confident pass.
        //
        // The budget is stated here rather than in the root block, because
        // the root's `testTimeout` does not reach an inline project either:
        // a test sleeping six seconds here times out at Vitest's 5s default
        // with the root block set to 20s.
        test: {
          name: "ci-config",
          include: ["ci/**/*.test.ts"],
          ...sharedTestBudget,
        },
      },
    ],
  },
});
