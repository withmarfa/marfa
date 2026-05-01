import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/runtime-control",
    include: ["src/**/*.test.ts"],
  },
});
