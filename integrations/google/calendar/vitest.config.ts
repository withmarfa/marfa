import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "google-calendar",
    include: ["src/**/*.test.ts"],
  },
});
