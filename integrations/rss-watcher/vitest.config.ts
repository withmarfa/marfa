import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-rss-watcher",
    include: ["src/**/*.test.ts"],
  },
});
