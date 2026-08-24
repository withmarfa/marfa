import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "readwise-highlights",
    include: ["src/**/*.test.ts"],
  },
});
