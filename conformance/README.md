# conformance

The referee for the Marfa server: black-box fixtures every implementation must
pass, run over HTTP against a locally booted server, and the written
specification under `spec/` that states what those fixtures assert.

The suite sits beside the server it gates, so a change to the contract and the
change to the server that satisfies it are one pull request. It still reaches
the server over HTTP alone: nothing under `src/suites/` imports a workspace
package.

## Quick start

From this directory, in a checkout where `pnpm install` has been run at the
root:

```bash
# Boot the server in this checkout on SQLite, mint its first key, write an env file
pnpm marfa:up

# Correctness + compliance + sync against it
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
pnpm test:sync          # the server's half of the sync contract, over the event stream
pnpm test:conformance   # the three above; what the gate runs
pnpm test:generators    # offline: generators, harness and boot-helper unit tests
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
  suites/
    correctness/  — functional correctness tests
    compliance/   — spec adherence tests
    sync/         — the sync contract's server half
    performance/  — latency benchmarks
    load/         — sustained load tests
```

Tests are isolated by credential: each file mints a key with a unique
`source`, writes through it, and `cleanup` in `afterAll` deletes every tracked
resource and revokes the key. No shared state between files.

## Continuous integration

The `conformance` job in `.github/workflows/ci.yml` is the gate, on every pull
request and every push to `main`. It builds the checkout, runs the offline
lane, boots that same checkout's server on SQLite with `pnpm marfa:up`, runs
`pnpm test:conformance` against it, and stops it whatever the result. There is
no pinned server commit and no second checkout: the tree under test is the
tree the suite runs against.

Typecheck and formatting are not repeated there. The repository root's
`pnpm typecheck` and `pnpm format:check` reach this package, and both run in
the `CI (SQLite)` job.
