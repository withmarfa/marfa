import { defineConfig } from "vitest/config";

import { sharedTestBudget } from "../../vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestBudget,
    name: "@withmarfa/sync-manifest",
    include: ["src/**/*.test.ts"],
  },
});
