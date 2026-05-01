import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-rss-watcher",
    include: ["src/**/*.test.ts"],
  },
});
