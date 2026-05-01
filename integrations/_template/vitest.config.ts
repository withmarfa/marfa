import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-template",
    include: ["src/**/*.test.ts"],
  },
});
