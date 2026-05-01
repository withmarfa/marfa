import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-google-calendar",
    include: ["src/**/*.test.ts"],
  },
});
