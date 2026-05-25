import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@withmarfa/integration-withmarfa-inbox",
    include: ["src/**/*.test.ts"],
  },
});
