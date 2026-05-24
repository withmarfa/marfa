import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-todoist",
    include: ["src/**/*.test.ts"],
  },
});
