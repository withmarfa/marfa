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
# Boot the object store the server attaches beside its disk (brew install garage)
pnpm garage:up
set -a; . .marfa-state/garage/garage.env; set +a

# Boot the server in this checkout on SQLite, mint its first key, write an env file
pnpm marfa:up

# Build the device under test. The device fixtures drive this binary, and
# `marfa:up` does not build it: it boots a server, and the device is not one.
# They refuse a binary older than the source it came from, so build it again
# after any change under `core/`.
(cd ../core && cargo build -p marfa-cli)
export MARFA_DEVICE_BIN="$PWD/../core/target/debug/marfa"

# Correctness, compliance, the server's write contract and the device's half
set -a; . .marfa-state/env; set +a
pnpm test:conformance

pnpm marfa:down
pnpm garage:down
```

`pnpm garage:up` starts a single-node [Garage](https://garagehq.deuxfleurs.fr)
under `.marfa-state/garage/`, creates a bucket and a key, and writes the
`S3_*` values that name them to `.marfa-state/garage/garage.env` (and to
`GITHUB_ENV` in a workflow). Source that file before `pnpm marfa:up`: the
server attaches an object store when `S3_BUCKET` is set, and the fixtures in
`spec/stores.md` assert both stores rather than skipping when one is missing.
`pnpm garage:down` stops the node and removes its state.

`pnpm marfa:up` builds the workspace packages if they are not built, starts
the server with `tsx` (never watch mode), waits for `/health`, reads the
one-time bootstrap secret from the server's own log, mints the first key with
it, and writes `.marfa-state/env`. The state directory holds the
SQLite file, the disk store, the server log, the pid and the env file; pass
`--state <dir>` to put it elsewhere and `--port <n>` to choose the port.

The server runs with enrichment, OCR and rate limiting switched off.
Enrichment rewrites file items in the background, which would make
exact-property assertions on blobs depend on timing. Rate limiting is off so
that a run's own key minting and revocation, one of each per file, cannot meet
the one fixed limit the server has — `/keys`, in `packages/server/src/app.ts`.
Nothing in the fixtures asserts either.

## Configuration

| Variable             | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `MARFA_API_URL`      | The booted server. Unset, the run stops: there is no default target.              |
| `MARFA_API_KEY`      | The key the bootstrap mint returns.                                               |
| `MARFA_OPERATOR_KEY` | The same key, named for its reach on the operator-only routes.                    |
| `MARFA_DEVICE_BIN`   | The built `marfa` binary the device fixtures drive.                               |
| `MARFA_LOAD_PROFILE` | Sizes the load suites. `smoke` unset; `src/suites/load/profiles.ts` has the rest. |

**`pnpm test:conformance` needs the first four.** `pnpm marfa:up` writes the
first three — the bootstrap mint returns one key and two of them hold it — and
the fourth is yours. An unset `MARFA_OPERATOR_KEY` throws in
`src/utils/setup.ts`, an unset `MARFA_DEVICE_BIN` in
`src/suites/device/harness.ts`, and neither is a skip.

`MARFA_API_KEY` is the key the suite provisions with. It holds no content
permissions itself, but a key it mints naming no permission maps carries the
whole dataset, and that is how each test file gets its own key, with a
`source` unique to that file. The server stamps `source` from the credential,
so every row a file writes is attributable to it and to nothing else, and
teardown revokes the file's key through the provisioning key.

Each load suite seeds its own corpus under its own credential, measures, and
deletes what it created.

## Test suites

`package.json` carries the full list, and `pnpm test:conformance` is what the
gate runs. `pnpm test:generators` is the offline lane and needs no server: the
generators, everything under `src/utils/` — including
`spec-citations.test.ts` and `schema-coverage.test.ts`, which read the
specification against itself — and the `*.decision.test.ts` verdicts the
suites gate on. `vitest.config.ts` decides which file lands in which project,
and the `test:conformance` script decides which projects the gate runs.
`test:performance` and `test:load` sit off the gate.

## Architecture

`spec/` is the written specification, one file per area, citing fixtures.
`scripts/marfa-server.ts` boots, mints and stops a local server. Under `src/`,
`client/` is the typed HTTP client, `generators/` the synthetic data, `utils/`
the test context and teardown, `device/` the scripted server and the CLI
adapter, and `suites/` the fixtures themselves, one directory per project.

Tests are isolated by credential: each file mints a key with a unique
`source`, writes through it, and `cleanup` in `afterAll` deletes every tracked
resource and revokes the key. No shared state between files. A door whose
answer is the instance's whole history rather than rows a key can isolate,
such as the owner, boots its own server with `bootFreshServer` in
`utils/fresh-server.ts` and stops it in `afterAll`.

## CI

The `conformance` job in `.github/workflows/ci.yml` is the gate, on every pull
request and every push to `main`. The tree under test is the tree the suite
runs against and the device under test is the binary built from it: there is
no pinned server commit and no second checkout. Typecheck, lint and formatting
are not repeated there: the repository root's own checks reach this package
and run in the job beside it. Lint is the one worth knowing about, because
this package is deliberately not clean under the root ESLint config and
`eslint.config.js` at the root says why.
