import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/runtime-test",
    include: ["src/**/*.test.ts"],
  },
});
