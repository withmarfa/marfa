import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "acme-template",
    include: ["src/**/*.test.ts"],
  },
});
