import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/sync-manifest",
    include: ["src/**/*.test.ts"],
  },
});
