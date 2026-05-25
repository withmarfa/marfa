import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-sync",
    include: ["src/**/*.test.ts"],
  },
});
