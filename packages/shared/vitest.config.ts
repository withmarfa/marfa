import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/shared",
    include: ["src/**/*.test.ts"],
  },
});
