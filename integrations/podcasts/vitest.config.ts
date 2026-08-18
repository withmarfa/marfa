import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-podcasts",
    include: ["src/**/*.test.ts"],
  },
});
