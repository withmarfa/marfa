import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-inbox",
    include: ["src/**/*.test.ts"],
  },
});
