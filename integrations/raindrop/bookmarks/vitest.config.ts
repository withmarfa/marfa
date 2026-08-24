import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-raindrop",
    include: ["src/**/*.test.ts"],
  },
});
