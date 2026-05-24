import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-mymehq-inbox-email-worker",
    include: ["src/**/*.test.ts"],
  },
});
