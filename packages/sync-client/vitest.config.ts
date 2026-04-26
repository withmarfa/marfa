import { defineConfig } from "vitest/config";

/**
 * Default test project — picked up by the root `vitest.config.ts`'s
 * `projects: ["packages/*"]`. Restricts inclusion to the unit suite so
 * the integration tier (which spawns a real server and talks to
 * Atlas) does not leak into the default `pnpm test` / pre-push runs.
 *
 * Run integration explicitly with `pnpm --filter @mymehq/sync-client test:integration`.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
