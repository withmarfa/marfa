import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-withmarfa-inbox-email-worker",
    include: ["src/**/*.test.ts"],
  },
});
