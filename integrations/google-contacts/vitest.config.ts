import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-google-contacts",
    include: ["src/**/*.test.ts"],
  },
});
