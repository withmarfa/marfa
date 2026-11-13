# conformance

Marfa's contract and the black-box fixtures that hold an implementation to it. The contract, in `spec/`, states what a Marfa server, device and command line must do, one requirement per statement. The fixtures, in `src/suites/`, assert it from outside: they import nothing from the code they judge.

## The two halves

- **The server's half** runs over HTTP and the server's private control socket against a server the suite boots itself. You build the server, and the suite starts it, claims it, mints its keys and stops it. The projects are `correctness`, `compliance` and `sync`.
- **The device's half** judges the `marfa` binary and the Node module the core builds, rather than the server. A device holds a working copy and a queue, and some of the failures it must handle are ones a real server cannot be asked for, such as a dropped connection or a refusal repeated until a ceiling. So these fixtures drive a server the fixture scripts (`src/device/scripted-server.ts`), and `src/suites/device/fidelity.test.ts` holds each scripted answer to the real server's where the real server can produce it. That is the `device` project. The `cli` project, the scenario suite, drives the `marfa` binary end to end against a server the suite boots, as a person or an agent uses it at a terminal.

## Run it

You need the repository's dependencies (`pnpm install` at the root), a Rust toolchain, and [Garage](https://garagehq.deuxfleurs.fr) for the fixtures that use an object store.

```bash
cd conformance
(cd ../core && cargo build --release -p marfa-server --features test-hooks)
export MARFA_SERVER_BIN="$PWD/../core/target/release/marfa-server"
pnpm marfa:up
set -a; . .marfa-state/env; set +a
pnpm test:correctness
pnpm marfa:down
```

`pnpm test:generators` runs the checks that need no server, including the checks of the contract's own form.

## Measurements

These measure a release build of the server, with no test hooks, from outside. Each checks what came back, so a figure cannot pass on a wrong answer.

- `pnpm test:performance`, `pnpm test:load` and `pnpm test:hydration` run every night in `.github/workflows/benchmarks.yml`. `MARFA_LOAD_PROFILE` sizes the load suites (`smoke` when unset; `src/suites/load/profiles.ts` has the rest). `test:hydration` fills a working copy from a large image library with a release build of `marfa` (`MARFA_DEVICE_BIN`), `MARFA_HYDRATION_ROWS` items in each set (2,000 when unset), and writes `reports/load/hydration.json`.
- `pnpm scale tables --server <marfa-server>` writes and reads one very large table, then times an undo, an export, a restore and a purge, and writes `reports/scale/tables.json`.
- `pnpm scale conversations --server <marfa-server>` writes and reads chat conversations, including messages sent out of order, then exports and restores them, and writes `reports/scale/conversations.json`.

The two `scale` tools run on request, boot servers of their own and stop them by process ID. Their options are defined in `scripts/scale/tables.ts` and `scripts/scale/conversations.ts`.

## Where the rest is

- [`spec/README.md`](spec/README.md): how a contract statement is written, and the list of chapters.
- [`TARGET-INTERFACE.md`](TARGET-INTERFACE.md): the adapter that starts and arranges a server, the faults, the clock, the device's binding and the request log. Another implementation that supplies the same interface is judged by the same fixtures.
- [`AGENTS.md`](AGENTS.md): the rules for writing a fixture.
- [`../.agents/skills/run-the-contract/SKILL.md`](../.agents/skills/run-the-contract/SKILL.md): every step of a local run, including the object store, the device binary, the status check and the score.
