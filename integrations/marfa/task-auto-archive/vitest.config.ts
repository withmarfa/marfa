import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-task-auto-archive",
    include: ["src/**/*.test.ts"],
  },
});
