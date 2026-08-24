import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "google-youtube",
    include: ["src/**/*.test.ts"],
  },
});
