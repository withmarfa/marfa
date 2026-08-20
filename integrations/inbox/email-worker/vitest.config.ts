import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-inbox-email-worker",
    include: ["src/**/*.test.ts"],
  },
});
