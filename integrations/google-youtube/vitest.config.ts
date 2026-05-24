import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-google-youtube",
    include: ["src/**/*.test.ts"],
  },
});
