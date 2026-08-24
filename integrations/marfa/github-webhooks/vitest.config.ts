import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-github-webhooks",
    include: ["src/**/*.test.ts"],
  },
});
