import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-google-tasks",
    include: ["src/**/*.test.ts"],
  },
});
