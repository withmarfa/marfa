import { defineConfig } from "vitest/config";

// Own config so the root `projects` glob can pick this package up. Without an
// entry here the infra tests never run under `pnpm test`, which is the check
// CI gates on — and a contract test that never executes is not a contract.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
