import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-readwise-reader",
    include: ["src/**/*.test.ts"],
  },
});
