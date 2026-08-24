import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-google-drive",
    include: ["src/**/*.test.ts"],
  },
});
