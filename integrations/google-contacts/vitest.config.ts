import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-google-contacts",
    include: ["src/**/*.test.ts"],
  },
});
