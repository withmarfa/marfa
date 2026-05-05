import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/webhook-protocol",
    include: ["src/**/*.test.ts"],
  },
});
