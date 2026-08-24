import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-todoist",
    include: ["src/**/*.test.ts"],
  },
});
