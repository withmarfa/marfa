import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/runtime-test",
    include: ["src/**/*.test.ts"],
  },
});
