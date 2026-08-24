import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "raindrop-bookmarks",
    include: ["src/**/*.test.ts"],
  },
});
