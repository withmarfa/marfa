import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mymehq/integration-raindrop",
    include: ["src/**/*.test.ts"],
  },
});
