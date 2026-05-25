import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-template",
    include: ["src/**/*.test.ts"],
  },
});
