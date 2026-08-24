import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "google-drive",
    include: ["src/**/*.test.ts"],
  },
});
