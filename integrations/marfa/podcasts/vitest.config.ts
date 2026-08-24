import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-podcasts",
    include: ["src/**/*.test.ts"],
  },
});
