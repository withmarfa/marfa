import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-sync-agent",
    include: ["src/**/*.test.ts"],
  },
});
