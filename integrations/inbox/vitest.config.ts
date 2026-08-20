import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-inbox",
    include: ["src/**/*.test.ts"],
  },
});
