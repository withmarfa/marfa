import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-github-webhooks",
    include: ["src/**/*.test.ts"],
  },
});
