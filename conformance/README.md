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

**The scenario suite** is `src/suites/cli/`, and it gates the `marfa` binary
as the reference client of an instance: every scenario is a person or an agent
at a terminal, driving the built binary against the server the run booted, end
to end. Signing in, creating, attaching, searching, linking, a folder round
trip, an export, a connector's registration and runs, instance management operations, the
six exit codes, and a coverage scenario that reads `marfa operations` from the
binary and holds it against the document the server serves, so an operation
published without a command is red here. Every published operation is driven
past its help but one, `types prune`, which needs a drifted platform type a
fresh server does not have; the coverage scenario says so. It is its own job
in `ci.yml`, beside the referee rather than inside it, and `pnpm test:cli`
runs it with the same environment the device fixtures take.

## Quick start

From this directory, in a checkout where `pnpm install` has been run at the
root:

```bash
# Boot the object store the server attaches beside its disk (brew install garage,
# or a release binary from garagehq.deuxfleurs.fr)
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

# The scenario suite: the binary as the reference client, end to end
pnpm test:cli

# Hold what the run observed to what the document declares. Before
# `marfa:down`, which clears the log it reads.
pnpm check:statuses

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

`pnpm drill:restore` is the restore drill, which needs the same `S3_*` values
plus `litestream` and `sqlite3` on the path: it boots an instance under
`.marfa-drill/` with Litestream streaming its database to the bucket, writes
to it, restores a second instance from the bucket alone and compares the two
to the byte, then removes what it wrote to the bucket. The report goes to
`reports/restore-drill.md`, and `deploy/README.md` is what it proves.

`pnpm marfa:up` builds the workspace packages if they are not built, starts
the server with `tsx` (never watch mode), waits for `/health`, claims the owner through the private socket using the
production claim service, signs in, mints explicit ordinary fixture keys,
and writes `.marfa-state/env`. The state directory holds the
SQLite file, the disk store, the server log, the pid and the env file; pass
`--state <dir>` to put it elsewhere and `--port <n>` to choose the port.

`pnpm marfa:down` stops the server and removes its instance state, so every `up` is
a fresh instance. A database that outlives the bucket it was pointed at
registers a second object store beside the first, and `scripts/marfa-server.ts`
says why. `garage/` sits inside the same directory and is `garage:down`'s to
remove.

The server runs with enrichment, OCR and general request rate limiting switched off. Password sign-in throttling remains enabled. Owner fixtures share a session in a file with mode `0600`, validate its authentication time with the server, and serialize password sign-ins across workers when it needs renewal. The launcher retains its authentication secret in the protected env file so a restart can reuse a valid session.
Enrichment rewrites file items in the background, which would make
exact-property assertions on blobs depend on timing. Rate limiting is off so
that a run's own key minting and revocation, one of each per file, cannot
spend the allowance on the key operations — the tightest cap the server has, set
in `packages/server/src/app.ts`. `marfa:up` says so outright rather than
leaving it to the boot script's default, so an ambient variable cannot flip
the instance every file shares. What that allowance is, and what a caller
past it is told, is asserted in `compliance/key-rate-limit.test.ts` against a
server booted for it; nothing in the fixtures asserts enrichment. Two of the copy rules' settings are
set for the fixtures that drive them through the housekeeping operations: the
orphan sweep's grace is zero, so the run after a report purges, and
replication's cadence is an hour, so nothing copies on a clock of its own
between an upload's wake and the fixture's runs. The env file also carries
`MARFA_BLOB_PATH`, the booted server's disk store, for the fixture that
corrupts a copy under it.

## Configuration

| Variable                    | Description                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`             | The booted server. Unset, the run stops: there is no default target.                                           |
| `MARFA_API_KEY`             | Ordinary content/provisioning key with the original seven named permissions and write access in all five maps. |
| `MARFA_MANAGEMENT_KEY`      | Ordinary management fixture key with all twelve named permissions and empty content maps.                      |
| `MARFA_OWNER_SESSION_FILE`  | Protected shared session file used by owner fixtures to reuse a recent sign-in across test processes.          |
| `MARFA_FIXTURE_AUTH_SECRET` | Launcher state used to keep cookie signatures valid across restarts; it does not configure other instances.    |
| `MARFA_OWNER_COOKIE`        | The owner's production sign-in session, used for direct-owner fixtures.                                        |
| `MARFA_CONTROL_SOCKET`      | Absolute path to the fixture server's private socket.                                                          |
| `MARFA_DEVICE_BIN`          | The built `marfa` binary the device fixtures and scenario suite drive.                                         |
| `MARFA_LOAD_PROFILE`        | Sizes the load suites. `smoke` when unset; `src/suites/load/profiles.ts` has the rest.                         |

`pnpm marfa:up` writes the server URL, both ordinary keys, owner cookie and private socket path. Set `MARFA_DEVICE_BIN` to the binary you built before running `pnpm test:conformance`. Required fixture credentials and the binary fail explicitly when missing; they do not skip tests. The state file contains credentials and must remain private to the test account.

`MARFA_API_KEY` delegates content access and the seven permissions `schema.write`, `keys.mint`, `items.purge`, `webhooks.manage`, `config.manage`, `audit.read` and `grants.manage`. Each test file mints its own key with a unique `source`. The server stamps each row with that source, or with one the key explicitly claims when the write names it, so each file can identify its own rows. Teardown uses the management key to revoke the file's keys. Fixtures that need direct authority use the owner session or the private socket; neither ordinary fixture key supplies it.

Each load suite seeds its own corpus under its own credential, measures, and
deletes what it created.

## Test suites

`package.json` carries the full list, and `pnpm test:conformance` is what the
gate runs. `pnpm test:generators` is the offline lane and needs no server: the
generators, everything under `src/utils/`, and the `*.decision.test.ts`
verdicts the suites gate on. Among `src/utils/`, `schema-coverage.test.ts`
reads the specification against itself, and `spec-citations.test.ts` holds
every reference to it in the repository to a rule that exists, by ID.
`vitest.config.ts` decides which file lands in which project, and the
`test:conformance` script decides which projects a local run of the gate runs;
CI runs the same projects as shards.
`test:cli` is the scenario suite's own gate, run by its own job.
`test:performance` and `test:load` sit off the gate, and run every night and
on request in `.github/workflows/benchmarks.yml`, the load suites at the
`smoke` profile.

## Architecture

`spec/` is the written specification, one file per area, citing fixtures.
`scripts/marfa-server.ts` boots, mints and stops a local server, and
`scripts/restore-drill.ts` boots two of them for the restore drill. Under `src/`,
`client/` is the typed HTTP client, `generators/` the synthetic data, `utils/`
the test context and teardown, `device/` the scripted server and the CLI
adapter, and `suites/` the fixtures themselves, one directory per project.

Tests are isolated by credential: each file mints a key with a unique
`source`, writes through it, and `cleanup` in `afterAll` deletes every tracked
resource and revokes the key. No shared state between files. An operation whose
answer is the instance's whole history rather than rows a key can isolate,
such as the owner, boots its own server with `bootFreshServer` in
`utils/fresh-server.ts` and stops it in `afterAll`.

## CI

The contract's gate is `Conformance` in `.github/workflows/ci.yml`, on every pull
request that can affect it and every push to `main`, on Ubuntu; it also runs on
macOS every night and when the workflow is dispatched with `macos`. It is a
check that collects the jobs below and passes when every one that ran passed,
or when the classifier skipped them all.

- **Shards.** The server's fixtures run in three groups, each on runners of
  its own that boot their own object store and server: correctness and sync on
  one, compliance over four and the device over four. The fixtures isolate
  themselves by credential, so a runner takes any part of a group. A group of
  more than one shard splits its files with `pnpm test:compliance --shard=1/4`,
  weighed by the seconds each file takes (`src/utils/shard-weights.ts`) rather
  than by Vitest's own split by path, which can leave one shard with far more of the slow files than another.
  A file not in the weights is still run, by exactly one shard. Only the device
  shards build or restore the `marfa` binary.
- **Offline lane.** `pnpm test:generators` runs as a job of its own, with no
  server.
- **Statuses.** Each shard holds the statuses its server answered to their
  declaration and keeps its server log and the document it served.
  `Conformance statuses` then merges every shard's log and holds the declared
  statuses no request drew to the list of the ones nothing can draw
  (`pnpm check:statuses --shards <dir> --complete`). That needs the whole
  selection, so it runs when the change reaches all three groups; a change to
  one group's fixtures runs that group, and the push to `main` that follows
  runs them all.

`scripts/ci-required.ts` says which groups a change reaches and writes the
matrix. A change to `spec/` alone runs the offline lane, and the compliance
shards only for `errors.md` and `coverage.md`, the two chapters a fixture reads
while it runs.

The tree under test is the tree the suite runs against and the device under
test is the binary built from it: there is no pinned server commit and no
second checkout. Typecheck, lint and formatting are not repeated there: the
repository root's own checks reach this package and run in the job beside it.
Lint is the one worth knowing about, because this package is deliberately not
clean under the root ESLint config and `eslint.config.js` at the root says why.
