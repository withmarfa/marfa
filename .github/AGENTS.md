# CI

For changes to a workflow, to `scripts/ci-required.ts` or to the tests in `ci/`. The workflows and the classifier carry their own comments, which say what each job does. This file holds the rules an editor must keep and the test that pins each.

## What runs when

- **A draft pull request** runs the quick jobs only: `Quick checks`, `Typecheck`, `Lint`, `Types codegen freshness` and `No file holds a version`. The gate is named `Draft CI`, so the required `Full CI` stays pending and blocks a merge.
- **A pull request that is ready, and every push after,** runs every job the classifier says the diff can affect. A failed `Quick checks`, `Typecheck` or `Lint` cancels the rest of the run, and the gate still runs and fails.
- **A push to `main`** runs everything but the `core` job and the Rust contract on macOS, unless the push is documentation only and `ci.yml` passed on the commit before. It is never canceled. `core.yml` runs the core's live checks for a push that touches the core.
- **The nightly run** of `ci.yml` runs only what needs a Mac: `Core checks`, the Swift package and the Rust contract on macOS. `core.yml` and `benchmarks.yml` run their own nights.
- **A dispatch** runs everything but the `core` job, and the Rust contract on macOS only with the `macos` input.

## Rules

- **The gate needs every job.** `Full CI` waits for every other job of `ci.yml` but the nightly report and passes only when each ended as `success` or `skipped`. A job you add is a need of the gate (`ci/full-ci-gate.test.ts`).
- **A skipped job counts as passed.** So a classifier rule that leaves out a job that reads a path is a silent pass. `scripts/ci-required.ts` matches each changed path to the first rule that names it, and a path no rule names, or a change to the classifier, runs everything. When a job starts reading a file, including through `include_str!` or as a test fixture, change that file's rule in the same pull request (`ci/ci-required.test.ts`).
- **Only `ci.yml`, `codeql.yml` and `pr-description.yml` start on a pull request.** No other workflow runs tests there (`ci/core-gate.test.ts`). The core's live checks, `core-live.yml`, are the `core` job of `ci.yml` for a pull request.
- **Standard GitHub-hosted runners only,** never personal or paid third-party ones, and a Mac only where a Mac is needed (`ci/workflow-runner.test.ts`).
- **A draft run and a ready run are in separate concurrency groups,** in `ci.yml` and in `codeql.yml`, so that neither cancels the other (`ci/workflow-runner.test.ts`).
- **Every job has a `timeout-minutes`** of about twice its slowest recent run, and uploads an artifact only after a failure, except the ones `KEPT_ON_SUCCESS` in `ci/job-limits.test.ts` lists, each with its reason.
- **Every scheduled workflow but CodeQL ends with a `report-failure` job,** which opens or comments on one issue titled `Nightly failed: <workflow>`. A scheduled workflow you add gets the same job (`ci/nightly-report.test.ts`).
- **The native build image is cached** by the action `.github/actions/native-build-image`, keyed by the hash `native/image.sh key` prints, so a run with a cache hit never contacts the package archive (`ci/native-build-image.test.ts`). Every cache but the pnpm store is saved only from `main`.

## The Rust contract jobs

`Rust server (release build)` builds the server once for the static musl target, with the file readers linked in. Twenty shards boot that build through `MARFA_SERVER_BIN` and run the contract's fixtures against it. A shard passes when a test fails, so that every shard reports: `Rust contract score` is the verdict, and it fails when a file listed in `conformance/src/utils/rust-judged.ts` did not pass whole or a shard wrote no report. It counts a skipped test as not passing, apart from tests that run only on macOS, which `Rust contract score on macOS` judges at night. `MCP conformance` and the `Restore drill` boot the same build.

## Traps

- **A job that reaches its `timeout-minutes` ends as `cancelled`, not `failure`.** A condition that uses `failure()` is false for it.
- **`release.yml` requires a green `ci.yml` run on the commit, and nothing else.** A check moved out of `ci.yml`, to `core.yml`, the nightly or the benchmarks, stops gating a release.
- **A pull request runs its own copy of the workflow files.** Prove a change to the gate with a throwaway pull request that fails on purpose.
- **The Actions cache has a size limit for the whole repository.** Adding a cache can push out one that a slow job depends on.
