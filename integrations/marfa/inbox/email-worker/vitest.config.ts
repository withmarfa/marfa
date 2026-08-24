import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "marfa-inbox-email-worker",
    include: ["src/**/*.test.ts"],
  },
});
