import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // @mymehq/electric is parked (see packages/electric/README.md). It is
    // excluded from the workspace, so its dependencies aren't installed
    // and the test files can't resolve their imports. Skip the package
    // entirely.
    projects: ["packages/*", "!packages/electric"],
    // When STORAGE_DIALECT=pg, every test file truncates a shared database
    // at startup (see packages/server/src/test-utils.ts createTestContext).
    // With parallel workers, worker A's bootstrap admin key gets wiped by
    // worker B's truncate before A's first request lands, surfacing as
    // spurious 401s. fileParallelism=false forces maxWorkers=1 for the PG
    // run, serialising the truncate/bootstrap/exercise cycle. SQLite stays
    // parallel (each file uses its own tmpdir DB).
    //
    // Vitest 4 removed poolOptions.forks.singleFork — this is the replacement.
    fileParallelism: process.env.STORAGE_DIALECT !== "pg",
  },
});
