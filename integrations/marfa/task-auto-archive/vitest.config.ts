import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-task-auto-archive",
    include: ["src/**/*.test.ts"],
  },
});
