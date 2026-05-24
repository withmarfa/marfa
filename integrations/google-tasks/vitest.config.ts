import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-google-tasks",
    include: ["src/**/*.test.ts"],
  },
});
