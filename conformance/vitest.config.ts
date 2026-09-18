import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "generators",
          // The no-network lane. `*.decision.test.ts` under a suite folder is
          // a pure verdict driven over inputs rather than a run against a
          // target, so it belongs here: a decision the suites gate on should
          // fail with no server rather than only when somebody points one at
          // it. The suite projects exclude the same glob.
          include: [
            "src/generators/**/*.test.ts",
            "src/utils/**/*.test.ts",
            "src/suites/**/*.decision.test.ts",
          ],
          // Fixture generation (PDF/blob byte synthesis) is pure CPU work with
          // no network, but it is heavy enough that a loaded runner can take
          // tens of seconds on the blob fixtures. 60s covers that without
          // masking a real hang.
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "correctness",
          include: ["src/suites/correctness/**/*.test.ts"],
          // Budgeted for the heavy bodies rather than the typical one: 100+
          // edge hydration and pagination, and archive operations, run slowly
          // under the sustained load of a full serial run. Every file also
          // mints a key in `beforeAll` and deletes every tracked resource in
          // `afterAll`. 120s gives both room without masking a true stall — a
          // hung test still fails at 120s.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "performance",
          include: ["src/suites/performance/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "compliance",
          include: ["src/suites/compliance/**/*.test.ts"],
          // Matches correctness, for the same reasons: archive, bulk and
          // export bodies are slow under full-run load, and every file pays
          // the same mint-and-teardown cost.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // The server's half of the sync contract. Most bodies here open an
        // event stream and wait for a frame the write below them produces, so
        // the budget has to cover a subscribe, a round trip and a delivery
        // rather than a single request.
        test: {
          name: "sync",
          include: ["src/suites/sync/**/*.test.ts"],
          // Runs in the no-network lane instead; see the generators project.
          exclude: ["src/suites/sync/**/*.decision.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "load",
          include: ["src/suites/load/**/*.test.ts"],
          testTimeout: 1_800_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
