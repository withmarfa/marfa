import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "readwise-reader",
    include: ["src/**/*.test.ts"],
  },
});
