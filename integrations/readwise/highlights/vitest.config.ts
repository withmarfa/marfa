import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-readwise",
    include: ["src/**/*.test.ts"],
  },
});
