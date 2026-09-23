import { defineConfig } from "vitest/config";

import { sharedTestBudget } from "../../vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestBudget,
    name: "@withmarfa/client",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
