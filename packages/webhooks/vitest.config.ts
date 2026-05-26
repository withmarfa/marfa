import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/webhooks",
    include: ["src/**/*.test.ts"],
  },
});
