# conformance

The contract (`spec/`) and the fixtures that hold a server and a device to it (`src/suites/`). Commands here run from `conformance/`, in a checkout where `pnpm install` has run at the root.

- To run fixtures against a server you built, use the `run-the-contract` skill (`.agents/skills/run-the-contract/SKILL.md`).
- For the adapter's commands, the faults, the clock, the device's binding and the request log, read `TARGET-INTERFACE.md`.
- Before writing or changing a contract statement, read `spec/README.md`. It sets one requirement per statement, in RFC 2119 keywords and the EARS pattern, with a permanent ID that every reference uses.

## Rules

- Put a change to the contract and the change that satisfies it in the same pull request.
- Import no workspace package under `src/suites/`. A fixture reaches the server only over HTTP, the private control socket and the adapter, `scripts/marfa-server.ts`. No test enforces this; it holds by review.
- Isolate a fixture by credential. Each file mints its own key with a unique `source`, writes through it, and `cleanup` in `afterAll` deletes what it tracked and revokes the key. No state is shared between files.
- When an answer is the instance's whole history rather than items a key can isolate (such as the owner), or a fixture needs a setting `marfa:up` turns off (the rate limiter, enrichment, OCR, private webhook addresses), boot a server of its own with `bootFreshServer` from `src/utils/fresh-server.ts` and stop it in `afterAll`.
- Reach past the target interface (open the database, the disk store or the log) only where no door or fault can make the state. List the fixture in `TARGET-INTERFACE.md`, "Fixtures that reach past the target interface", with the reason. Reaching into `marfa.db` binds the contract to a column name.
- Give a fixture a title in a double- or single-quoted string. A statement cites a test by its exact title, and `spec-citations.test.ts` cannot read a title in a template literal.

## What a new test owes

These hold for every fixture that asserts an absence or waits on a stream, in any project.

- **A witness first.** Show that the thing was producible: the same path with the condition removed produces it. A silence (a filter that matched everything, an event that never came, a stream that was not listening) has an innocent explanation, and a test that cannot rule it out asserts nothing. Write the control before the assertion.
- **Wait on the stream's own signal, never on a fixed time.** A stream opens with a `stream_cursor` frame naming the log head; wait for a frame the server sends either way, drain what follows, then assert. Waiting on a frame that may never arrive ends in the runner's `Test timed out` and says nothing else. Some stream fixtures sleep 250 ms "for the subscription to settle"; do not copy that.
- **Settle an absence with a later frame.** A quiet window cannot tell "nothing more is coming" from "not yet". Write a sentinel after the thing under test and wait for the sentinel's own event.
- **No hand-rolled deadline.** A `while (cond && Date.now() < deadline)` loop followed by an assertion on `cond` turns the runner's timeout into a logic failure. Use the runner's budget, and pass `context.signal` to the stream helpers so an abort names what it waited for.
- **No other skips.** CI runs every shard with `--retry=0`, and the score counts every skip and todo as not passing except a test marked `ON_MACOS` (`src/utils/platform.ts`) off a Mac and a skip that sets `meta.unobservable` to its reason.

## The judged list

`RUST_JUDGED` in `src/utils/rust-judged.ts` lists every fixture file of the five server projects (`correctness`, `compliance`, `sync`, `device`, `cli`). `rust-judged.test.ts` fails the offline lane unless the list equals those files, so add a new fixture file to it in the same change. `Rust contract score` fails when a listed file does not pass whole. The `performance`, `load` and `hydration` files are not listed.

## Projects and lanes

`vitest.config.ts` decides which file lands in which project.

- `pnpm test:generators` is the offline lane and needs no server: the generators, everything under `src/utils/` but the harness tests, and the `*.decision.test.ts` verdicts. It runs `spec-form.test.ts` and `spec-citations.test.ts`; run both after any change under `spec/`.
- `pnpm test:harness` runs the `*.harness.test.ts` files, which boot the server `MARFA_SERVER_BIN` names to hold the adapter to `TARGET-INTERFACE.md`.
- `pnpm test:conformance` runs `correctness`, `compliance`, `sync` and `device` against the server `marfa:up` booted. `pnpm test:cli` runs the scenario suite, the `marfa` binary as a client end to end. Each project also has its own script (`pnpm test:compliance`).
- `pnpm test:performance`, `test:load` and `test:hydration` are measurements, run nightly by `.github/workflows/benchmarks.yml` against a release build with no test hooks.
- `pnpm test:changed` at the root runs `src/utils/` and the decision verdicts from this package, but not `src/generators/`; run `pnpm test:generators` yourself after changing a type definition.
- ESLint ignores `conformance/` (`eslint.config.js` says why), so only `tsc` and Prettier check it. Nothing catches an un-awaited promise in a fixture.

## Code Review Rules

- A test or fixture weakened, skipped, retried or removed so that something passes is a finding.
- A fixture file of the five server projects missing from `src/utils/rust-judged.ts`, or listed there without passing whole, is a finding.
- A stand-in in server code that exists only to make a fixture pass is a finding.
- A fixture that reaches past the target interface without its entry and reason in `TARGET-INTERFACE.md` is a finding.
