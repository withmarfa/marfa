import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-mymehq-inbox",
    include: ["src/**/*.test.ts"],
  },
});
