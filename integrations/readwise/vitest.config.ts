import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-readwise",
    include: ["src/**/*.test.ts"],
  },
});
