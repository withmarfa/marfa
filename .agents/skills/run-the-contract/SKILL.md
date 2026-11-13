---
name: run-the-contract
description: Run Marfa's conformance fixtures locally against a server you built. Build the server with test hooks, start the local object store, boot it with marfa:up through MARFA_SERVER_BIN, run one fixture file or a project, check the statuses, read the score, and tear down. Use before pushing a change to the server, the core or a fixture, or to reproduce a failing contract shard.
---

# Run the contract

Run every command from `conformance/`, in a checkout where `pnpm install` has run at the root. The adapter's commands and settings are in `conformance/TARGET-INTERFACE.md`; the rules for a fixture are in `conformance/AGENTS.md`.

**What it costs.** One fixture file is a light run. A whole project (`pnpm test:compliance`, `pnpm test:conformance`) runs many files at once, and many of them boot servers of their own; on a machine other work shares, run it the way that machine runs its heavy jobs. A Cargo build is heavy too.

## 1. Build the server with test hooks

```bash
cargo build --release -p marfa-server --features test-hooks --manifest-path ../core/Cargo.toml
export MARFA_SERVER_BIN="$PWD/../core/target/release/marfa-server"
```

If `CARGO_TARGET_DIR` is set, the binary is under that directory instead. `marfa:up` has no default binary on purpose: a default release build has no test hooks, and the fixtures turn the hooks on, which such a build refuses at start. Without `MARFA_SERVER_BIN`, `marfa:up` stops and says how to build one.

Only `src/suites/compliance/hook-free-server.test.ts` also needs the build a release ships, which it starts itself:

```bash
cargo build --release -p marfa-server --manifest-path ../core/Cargo.toml
export MARFA_SERVER_RELEASE_BIN=<path to that build's marfa-server>
```

Build it into a separate target directory, or copy the first build aside first: both builds write the same path.

## 2. Start the local object store

Needed for any file that touches files, blobs or backups; those fixtures fail, not skip, without it. Install [Garage](https://garagehq.deuxfleurs.fr) first.

```bash
pnpm garage:up
set -a; . .marfa-state/garage/garage.env; set +a
```

`garage:up` starts one node under `.marfa-state/garage/`, makes a bucket and a key, and writes the `S3_*` values to `garage.env`. Source it before `marfa:up`: the server attaches the store only when `S3_BUCKET` is set. Pass `--state <dir>` to put it elsewhere.

## 3. Boot the server

```bash
pnpm marfa:up
set -a; . .marfa-state/env; set +a
```

`marfa:up` boots `MARFA_SERVER_BIN` on `127.0.0.1` under a supervisor, claims the owner through the private socket, mints the fixture keys and writes `.marfa-state/env`. It turns off the rate limiter, enrichment and OCR and allows private webhook addresses. Vitest reads only `conformance/.env` itself, so source the state's env file. Pass `--state <dir>` and `--port <n>` to change where and on which port; `TARGET-INTERFACE.md`, "What `marfa:up` does", has the rest.

## 4. Build the device, for device and CLI fixtures

The `device` and `cli` projects drive the `marfa` binary; the `binding-*` files also drive the Node module, a debug build. Both refuse a build older than its source, so build again after any change under `core/`.

```bash
cargo build -p marfa-cli --manifest-path ../core/Cargo.toml
export MARFA_DEVICE_BIN="$PWD/../core/target/debug/marfa"
(cd ../core/bindings/node && pnpm --ignore-workspace install && pnpm --ignore-workspace run build:debug)
export MARFA_DEVICE_MODULE="$(ls "$PWD"/../core/bindings/node/*.node)"
```

## 5. Run fixtures

One file, in the project its folder names (`correctness`, `compliance`, `sync`, `device`, `cli`):

```bash
pnpm exec vitest run --project compliance src/suites/compliance/<file>.test.ts
```

A whole project: `pnpm test:compliance` (and `test:correctness`, `test:sync`, `test:device`, `test:cli`). `pnpm test:conformance` runs `correctness`, `compliance`, `sync` and `device` together. Fixtures that need no server: `pnpm test:generators`. The harness held to the target interface: `pnpm test:harness`, which boots its own servers from `MARFA_SERVER_BIN`.

To score the run afterwards, add `--reporter=default --reporter=json --outputFile=reports/run/vitest.json`.

## 6. Check the statuses

```bash
pnpm check:statuses
```

It holds every status the server logged to the one `openapi.json` declares for that route. Run it before `marfa:down`, which deletes the log it reads.

## 7. Read the score

```bash
pnpm rust:score --reports reports/run --projects compliance
```

It reads every `vitest.json` under `--reports` and prints tests passing out of all, by file and by project. It counts every skip and todo as not passing except a test that runs only on another platform (`ON_MACOS`) and one that sets `meta.unobservable`. It fails when a file in `src/utils/rust-judged.ts` did not pass whole or no report names it, so score a whole project's run, not one file's. `TARGET-INTERFACE.md`, "How the score is counted", has the rules.

For a report by contract chapter, run `pnpm chapter-report --report reports/run/vitest.json` before `marfa:down`. With `--state <dir> --windows <file>` (the windows come from `--reporter=./src/utils/file-windows.ts` with `MARFA_FILE_WINDOWS` set), it also sorts each failed file by whether it called an operation the server has no route for.

## 8. The other two checks

- `pnpm mcp:conformance` runs the MCP project's conformance tool against `/mcp` on the booted server. A check that fails by design is pinned in `scripts/mcp-conformance.ts` with its reason; any other failing check fails the run, and so does a pinned check that passes.
- `pnpm drill:restore` is the restore drill. It needs the `S3_*` values and `MARFA_SERVER_BIN`, boots its own servers under `.marfa-drill/`, backs one up, deletes its data, restores into a fresh server, compares the archive export and every file's bytes, and writes `reports/restore-drill.md`.

## 9. Tear down

```bash
pnpm marfa:down
pnpm garage:down
```

`marfa:down` stops the server and removes its state, so every `marfa:up` is a fresh instance. Pass the same `--state` you booted with. Stop a server only this way or by the process ID you started, never by name. A server nobody stopped stops itself after 30 minutes without a request.
