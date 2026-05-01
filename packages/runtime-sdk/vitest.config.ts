import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/runtime-sdk",
    include: ["src/**/*.test.ts"],
  },
});
