# conformance

The referee for Marfa: black-box fixtures every implementation must pass and
the written specification under `spec/` that states what those fixtures assert.

It has two halves. **The server's half** runs over HTTP against a locally
booted server. It sits beside the server it gates, so a change to the contract
and the change to the server that satisfies it are one pull request, and it
reaches the server over HTTP alone: nothing under `src/suites/` imports a
workspace package.

**The device's half** is `src/suites/device/`, and it gates the `marfa` binary
rather than the server. A device holds a working copy and a queue, and the
verdicts it has to reach include failures the real server cannot be asked for
— a dropped connection, a server at rest, a spent credential, a refusal
repeated until a ceiling. So those fixtures drive a server the fixture scripts
(`src/device/scripted-server.ts`), and `device/fidelity.test.ts` holds every
scripted answer against the real server's for the cases the real server can
produce. `spec/device.md` lists the cases it cannot, with a reason for each.

## Quick start

From this directory, in a checkout where `pnpm install` has been run at the
root:

```bash
# Boot the server in this checkout on SQLite, mint its first key, write an env file
pnpm marfa:up

# Build the device under test. The device fixtures drive this binary, and
# `marfa:up` does not build it: it boots a server, and the device is not one.
(cd ../core && cargo build -p marfa-cli)
export MARFA_DEVICE_BIN="$PWD/../core/target/debug/marfa"

# Correctness, compliance, the server's write contract and the device's half
set -a; . .marfa-state/env; set +a
pnpm test:conformance

pnpm marfa:down
```

`pnpm marfa:up` builds the workspace packages if they are not built, starts
the server with `tsx` (never watch mode), waits for `/health`, reads the
one-time bootstrap secret from the server's own log, mints the first key with
it, and writes `.marfa-state/env`. The state directory holds the
SQLite file, the blob folder, the server log, the pid and the env file; pass
`--state <dir>` to put it elsewhere and `--port <n>` to choose the port.

The server runs with enrichment, OCR and rate limiting switched off.
Enrichment rewrites file items in the background, which would make
exact-property assertions on blobs depend on timing. The `/keys` limit of 200
requests a minute per credential is exceeded by a local run's own key minting
and revocation, one of each per file. Nothing in the fixtures asserts either.

## Configuration

| Variable             | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `MARFA_API_URL`      | Required. The booted server.                            |
| `MARFA_API_KEY`      | Required. The key the bootstrap mint returns.           |
| `MARFA_OPERATOR_KEY` | The same key, for the operator-only maintenance routes. |
| `MARFA_DEVICE_BIN`   | The built `marfa` binary the device fixtures drive.     |

The bootstrap mint returns one key, and both variables hold it.

`MARFA_API_KEY` is the key the suite provisions with. It holds no content
permissions itself, but a key it mints naming no permission maps carries the
whole dataset, and that is how each test file gets its own key, with a
`source` unique to that file. The server stamps `source` from the credential,
so every row a file writes is attributable to it and to nothing else, and
teardown revokes the file's key through the provisioning key.

`MARFA_OPERATOR_KEY` is the same key named for the reach it has on the
operator routes; the fixtures for archive restore and platform-type
maintenance run as it.

There is no default target. An unset `MARFA_API_URL` stops the run.

## Test suites

```bash
pnpm test:correctness   # data integrity: persistence, versioning, lifecycle, metadata
pnpm test:compliance    # spec adherence: auth, types, permissions, error codes
pnpm test:sync          # the server's half of the write contract, over the event stream
pnpm test:device        # the device's half: the binary against a scripted server
pnpm test:conformance   # the four above; what the gate runs
pnpm test:generators    # offline: spec citations, coverage table, generators, harness
pnpm test:performance   # read/write latency benchmarks, off the gate
pnpm test:load          # sustained load and concurrency benchmarks, off the gate
```

### Load profiles

`MARFA_LOAD_PROFILE` sizes the load suites. Each of them seeds its own small
corpus under its own credential, measures, and deletes what it created. It
defaults to `smoke`.

```bash
pnpm test:load           # smoke — 80 items per read-oriented suite (default)
pnpm test:load:light     # 600
pnpm test:load:moderate  # 2,000
pnpm test:load:heavy     # 5,000
pnpm test:load:extreme   # 12,000
```

`src/suites/load/profiles.ts` is the whole shape. Each suite writes a JSON
report under `reports/load/`.

## Architecture

```
scripts/
  marfa-server.ts — boot, mint and stop a local server
spec/             — the written specification, one file per area, citing fixtures
src/
  client/         — typed HTTP client for the Marfa API
  generators/     — synthetic test data generators
  utils/          — test context, teardown, event-stream helpers
  device/         — the scripted server, the wire-shape builders, the adapter protocol, the CLI adapter
  suites/
    correctness/  — functional correctness tests
    compliance/   — spec adherence tests
    sync/         — the write contract's server half
    device/       — the device's half, driving the `marfa` binary
    performance/  — latency benchmarks
    load/         — sustained load tests
```

Tests are isolated by credential: each file mints a key with a unique
`source`, writes through it, and `cleanup` in `afterAll` deletes every tracked
resource and revokes the key. No shared state between files.

## Continuous integration

The `conformance` job in `.github/workflows/ci.yml` is the gate, on every pull
request and every push to `main`. It builds the checkout, builds the
`marfa` binary and exports `MARFA_DEVICE_BIN` for the device fixtures, runs
the offline lane, boots that same checkout's server on SQLite with
`pnpm marfa:up`, runs `pnpm test:conformance` against it, and stops it
whatever the result. There is no pinned server commit and no second checkout:
the tree under test is the tree the suite runs against, and the device under
test is the binary built from it.

Typecheck and formatting are not repeated there. The repository root's
`pnpm typecheck` and `pnpm format:check` reach this package, and both run in
the `CI (SQLite)` job.
