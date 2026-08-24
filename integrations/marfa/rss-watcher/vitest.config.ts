import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-rss-watcher",
    include: ["src/**/*.test.ts"],
  },
});
