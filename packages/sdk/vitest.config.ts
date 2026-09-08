import { defineConfig } from "vitest/config";

import { sharedTestBudget } from "../../vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestBudget,
    name: "@withmarfa/sdk",
    include: ["src/**/*.test.ts"],
    // Refuses the run when a sibling's build is older than its source. These
    // fixtures build a whole server out of `@withmarfa/server`'s `dist`, so
    // without it a route changed and not rebuilt is tested in its previous
    // form, silently.
    globalSetup: ["./src/test-global-setup.ts"],
    // Higher than the shared budget, and this is the package that made the
    // missing budget visible. `createHostedModeFixture` runs in `beforeEach`
    // rather than `beforeAll`, and each call makes a temp directory, opens a
    // SQLite database, builds the whole app and completes a real sign-up
    // round trip. That is a per-test cost, not a per-file one, and on a
    // machine also running the CI pool it blew the stock 10s hook budget on
    // two pull requests that touched none of it.
    //
    // 60s is chosen to sit clearly outside the range machine load can
    // produce, on the same order as the budget `server` chose for the same
    // reason. It is not sized to any measured duration: the fixture takes
    // about a second when nothing else is running, so anything approaching
    // this budget is a hang rather than a slow machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
