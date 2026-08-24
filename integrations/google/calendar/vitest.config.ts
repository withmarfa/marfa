import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-google-calendar",
    include: ["src/**/*.test.ts"],
  },
});
