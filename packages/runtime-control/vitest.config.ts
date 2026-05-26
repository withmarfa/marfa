import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/runtime-control",
    include: ["src/**/*.test.ts"],
  },
});
