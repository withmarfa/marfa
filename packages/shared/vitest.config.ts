import { defineConfig } from "vitest/config";

import { sharedTestBudget, silenceTelemetry } from "../../vitest.shared.ts";

silenceTelemetry();

export default defineConfig({
  test: {
    ...sharedTestBudget,
    name: "@withmarfa/shared",
    include: ["src/**/*.test.ts"],
  },
});
