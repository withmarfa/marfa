import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // @mymehq/electric is parked (see packages/electric/README.md). It is
    // excluded from the workspace, so its dependencies aren't installed
    // and the test files can't resolve their imports. Skip the package
    // entirely.
    projects: ["packages/*", "!packages/electric"],
  },
});
