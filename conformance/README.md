# conformance

The referee for Marfa: black-box fixtures every implementation must pass and
the written specification under `spec/` that states what those fixtures assert.

It has two halves. **The server's half** runs over HTTP against a locally
booted server. It sits beside the server it gates, so a change to the contract
and the change to the server that satisfies it are one pull request, and it
reaches the server over HTTP alone: nothing under `src/suites/` imports a
workspace package.

**The device's half** is `src/suites/device/`, and it gates the `marfa` binary
and the Node module rather than the server. A device holds a working copy and
a queue, and the verdicts it has to reach include failures the real server
cannot be asked for: a dropped connection, a server at rest, a spent
credential, a refusal repeated until a ceiling. So those fixtures drive a
server the fixture scripts (`src/device/scripted-server.ts`), and
`device/fidelity.test.ts` holds every scripted answer against the real
server's for the cases the real server can produce. `spec/device.md` lists the
cases it cannot, with a reason for each.

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

# Build the Node module the binding fixtures drive, a debug build: they hold
# the engine at a point and move the clock it waits by, which a release build
# leaves out. The device fixtures refuse a module older than its source too.
(cd ../core/bindings/node && pnpm --ignore-workspace install && pnpm --ignore-workspace run build:debug)
export MARFA_DEVICE_MODULE="$(ls "$PWD"/../core/bindings/node/*.node)"

# Correctness, compliance, the server's write contract and the device's half
set -a; . .marfa-state/env; set +a
pnpm test:conformance

# The scenario suite: the CLI as the reference client, end to end
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
the server as a direct Node child with the tsx loader (never watch mode), waits for `/health`, claims the owner through the private socket using the
production claim service, signs in, mints explicit ordinary fixture keys,
and writes `.marfa-state/env`. The state directory holds the
SQLite file, the disk store, the server log, what the server printed to stderr, the pid, the clock offset and the env file; pass
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
spend the allowance on the key operations (the tightest cap the server has, set
in `packages/server/src/app.ts`). `marfa:up` says so outright rather than
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
| `MARFA_DEVICE_MODULE`       | The built Node module, a debug build, the binding fixtures (`binding-*.test.ts`) drive.                        |
| `MARFA_LOAD_PROFILE`        | Sizes the load suites. `smoke` when unset; `src/suites/load/profiles.ts` has the rest.                         |

`pnpm marfa:up` writes the server URL, both ordinary keys, owner cookie and private socket path. Set `MARFA_DEVICE_BIN` to the binary and `MARFA_DEVICE_MODULE` to the module you built before running `pnpm test:conformance`. Required fixture credentials, the binary and the module fail explicitly when missing; they do not skip tests. The state file contains credentials and must remain private to the test account.

`MARFA_API_KEY` delegates content access and the seven permissions `schema.write`, `keys.mint`, `items.purge`, `webhooks.manage`, `config.manage`, `audit.read` and `grants.manage`. Each test file mints its own key with a unique `source`. The server stamps each row with that source, or with one the key explicitly claims when the write names it, so each file can identify its own rows. Teardown uses the management key to revoke the file's keys. Fixtures that need direct authority use the owner session or the private socket; neither ordinary fixture key supplies it.

Each load suite seeds its own corpus under its own credential, measures, and
deletes what it created.

## Target interface

The harness reaches the server under test through one adapter command,
`scripts/marfa-server.ts`, and never through the server's files. A second
implementation is judged by the same fixtures when it supplies an adapter with
the same commands and output.

Every command takes `--state <dir>`, the directory that holds the instance's
data, log and env file. The default is `.marfa-state` in the working directory.

| Command                                                          | What it does                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up [--port <n>] [--env K=V ...]`                                | Boots the target with the settings, claims it, mints the fixture keys and writes the env file. Exits 0 once the target answers `/health` and the keys exist.                                        |
| `restart [--signal TERM\|INT\|KILL] [--env K=V ...]`             | Stops the target with the signal, prints how it ended as `previous exit {"code":..,"signal":..,"ms":..}`, and boots it again on the same data. The URL may change.                                  |
| `down`                                                           | Stops the target and removes its data.                                                                                                                                                              |
| `status`                                                         | Exits 0 when the target is running, and prints its URL.                                                                                                                                             |
| `refused [--node-env <name>] [--env K=V ...]`                    | Boots with settings the target must refuse, as the `NODE_ENV` named when `--node-env` is given, and waits for it to end. Exits 0 when it ended; its exit record and log are in the state directory. |
| `clock advance <ms>`                                             | Moves the target's clock forward. A negative or fractional step is refused and the exit status is 1.                                                                                                |
| `fault set <name>[=<arg>]`, `fault clear [<name>]`, `fault list` | Sets or clears a named fault. `list` prints `{"faults":[{"name":..,"arg":..,"waiting":..}]}`, where `waiting` counts the callers held at a `hold` fault.                                            |

### The env file

`up` and `restart` write `<state>/env`, one `KEY=value` per line:
`MARFA_API_URL`, `MARFA_API_KEY`, `MARFA_MANAGEMENT_KEY`, `MARFA_CONTROL_SOCKET`,
`MARFA_OWNER_COOKIE`, `MARFA_OWNER_SESSION_FILE`, `MARFA_FIXTURE_AUTH_SECRET`,
`MARFA_BLOB_PATH` and `MARFA_STATUS_LOGS`. The file is private to the test
account.

### Settings

`--env K=V` names a setting for one boot. Any setting in the table of
[`spec/instance.md`](spec/instance.md) may be passed, and a value outside its
rule is refused as that chapter says. The adapter sets these itself, and a
value passed for one replaces its own:

- The port, the paths of the database, the disk store and the private socket,
  `MARFA_AUTH_SECRET` and `MARFA_AUTH_BASE_URL`.
- Enrichment, OCR and the request limiter off, a blob cleanup grace of 0, and
  webhook delivery to private addresses allowed, so the fixtures can use a
  receiver on the loopback address.
- `MARFA_TEST_HOOKS` true, except for a boot told to run as `production`
  (`--node-env production`), which would be refused for it.

### The clock

`clock advance` adds to an offset. The clock only moves forward, because ids,
versions and cursors assume time does not go back. The adapter keeps the offset
in the state directory and passes it back as `MARFA_TEST_CLOCK_OFFSET_MS`
when the target is restarted, so a restarted target does not go back in time.

The offset may not exceed 3153600000000 ms (100 years), the largest
`MARFA_TEST_CLOCK_OFFSET_MS`, so a restart can always take the offset back. A
move past it is refused and the clock stays where it was.

Timers and elapsed-time measures stay on real time: a job's deadline, a busy
wait, a stream's heartbeat and the server's uptime do not follow the clock. A
fixture moves the clock and then runs the job it tests with
`POST /housekeeping/{name}/run`.

After a clock move, no fixture may rely on an OAuth token, an owner session's
step-up, or the `Retry-After` date of a webhook receiver. Each compares a time
that the sign-in library or a peer sets in real time with the target's clock,
which the move has put out of step with it.

### Faults

A fault is named for where it acts, lives in the target's memory, and is gone
when the target starts. `FreshServer.stop()` clears the faults a fixture set.

| Name                         | What it does                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `hold:housekeeping:<job>`    | A run of the job waits at its start until the fault is cleared.                                                  |
| `hold:version-thinning:item` | The `version-thinning` job waits, for each item it has chosen to thin, before it removes anything from the item. |
| `deadline:<job>=<ms>`        | Shortens the run deadline of the job.                                                                            |

A fault that names a housekeeping job the target has not registered is refused,
as is a name that answers to no point. A refused fault is never armed, so a
typo cannot pass for one.

A webhook receiver's answers are the harness's own (`src/utils/webhook-receiver.ts`);
the target does not fake them.

### Who can reach the hooks

The clock and fault routes (`/_control/test/clock` and `/_control/test/faults`)
exist only on the private control socket, and only when `MARFA_TEST_HOOKS` is
`true`. They are never on the HTTP listener, and the server refuses to start with
the setting under `NODE_ENV=production`, which the released image sets. It logs
a warning at boot when the hooks are on. `spec/instance.md`, "Test hooks", holds
these rules.

### The device's binding

The device fixtures reach the device two ways. The `marfa` binary
(`MARFA_DEVICE_BIN`) runs one call at a time on a working copy it holds for
that call alone. The binding (`MARFA_DEVICE_MODULE`, the Node module `napi
build` writes) is for the rules a command cannot reach: a call that starts
while another waits on the same working copy, a follow told what its caller
was last told, a call held at a point, a wait read without being spent. A
second implementation is judged by the binding fixtures when it supplies what
follows.

- **The module.** It is loaded in a process of its own,
  `src/device/binding-host.mjs`, which the fixture talks to over IPC. A
  call that blocks its thread, as the engine's synchronous ones do while they
  read from the server, would otherwise stop the scripted server in the
  fixture's process answering it. Each request carries an `id` and is answered
  with the same `id` in whatever order the calls end, so two calls on one
  working copy can be in flight at once. The module exports the working
  copy's calls as `MarfaCore`, `Stop` and the changes a follow tells, told
  apart by `kind` (`applied`, `catalogChanged`, `serverUnreachable`,
  `serverReachable`, `queueDrained`, `queueNotDrained`, `saved`,
  `watchFailed`). A call that waits on the server, `withdraw` and `discard`
  among them, answers a promise.
- **`toldUnreachable`.** `follow` and `watch` take it as an optional last
  argument. It says the caller was last told `serverUnreachable` by an earlier
  one, so the first stream is told `serverReachable` and `serverUnreachable`
  is not told again before.
- **Holds.** The engine reaches named points, and a fixture arms one so that
  the engine waits there until the fixture releases it. `testHooks.hold(point)`
  arms a point, `testHooks.release(point)` lets go of what waits at it and
  disarms it, `testHooks.reached(point)` counts the times the engine has
  reached it, armed or not, and `testHooks.waiting(point)` counts the calls
  held at it now. A point is reached by a call on the engine's own thread, so
  a fixture waits for `waiting` before it acts on a held call.
  - `hydration-replacing`: after a hydration has begun to replace the copy,
    before it reads the first row.
  - `recovery-drain-asked`, `recovery-drain-found-none`: a held stream's drain,
    when it asks to drain and when it finds no work left.
  - `follow-waiting`: a follow that waits for a first hydration.
  - `answer-dropped`: an answer reached a request that nobody waited for.
- **The clock.** `testClock.manual()` sets the clock the engine waits by to
  one that moves only where `testClock.advance(ms)` moves it, and
  `testClock.waits()` lists the waits the engine has asked of it and the clock
  has not reached, each as the milliseconds asked and the milliseconds left.
  Set it before the calls whose waits are read. A wait asked of the system
  clock is not moved to the manual one. `testClock.manual(false)` goes back.
  Of the engine's waits, only the one between held streams and the two
  measures of a stream's age, how long it has been held and how long it has
  been silent, are read from it; the rest stay on the system clock.

A release build has no `testHooks` and no `testClock`: a fixture that uses
them fails on a module built `--release`, naming that. The module's build
needs the `napi` command its `package.json` pins, and the fixtures refuse a
module older than the binding's or the engine's source.

### The request log

The status gate, `pnpm check:statuses`, reads the target's stdout. The target
writes JSON objects, one per line, and nothing else to stdout. Anything else
the process prints, a Node warning or a stack trace, goes to stderr, which the
adapter keeps in `<state>/server.stderr` and the gate does not read.

A line with a string `level` and a string `message` is a log record, and the
gate skips it. Any other line is a request record, with the fields of `LogEntry`
in `packages/server/src/middleware/logger.ts`:

| Field         | Type    | Notes                                                                         |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| `timestamp`   | string  | ISO 8601.                                                                     |
| `request_id`  | string  |                                                                               |
| `method`      | string  |                                                                               |
| `transport`   | string  | `http` for the public listener, `local_socket` for the private socket.        |
| `path`        | string  | The concrete path.                                                            |
| `route`       | string  | The route template, as the document spells it. Absent when no route answered. |
| `status`      | integer |                                                                               |
| `duration_ms` | number  |                                                                               |
| `key_id`      | string  | Present when a key made the request.                                          |
| `error_code`  | string  | Present on a refusal that has a code.                                         |

The gate fails on a line that is not JSON, is not an object, or is a request
record missing `method`, `path`, `status` or `transport`. It names the file and
line and shows the start of the line. A request that no log line reaches is a
request nothing checked, so an unreadable line is a failure and not noise.

## Test suites

`package.json` carries the full list, and `pnpm test:conformance` is what the
gate runs. `pnpm test:generators` is the offline lane and needs no running target: the
generators, everything under `src/utils/`, and the `*.decision.test.ts`
verdicts the suites gate on. `src/utils/target-interface.test.ts` boots a
server of its own to hold the adapter to the interface above. Among `src/utils/`, `schema-coverage.test.ts`
reads the specification against itself, and `spec-citations.test.ts` holds
every reference to it in the repository to a rule that exists, by ID.
`pnpm test:changed` at the repository root always runs `src/utils/` and the
`*.decision.test.ts` verdicts from this lane, since they read the tree by path
and a diff cannot select them; the list is `scripts/whole-tree-tests.ts`.
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
  than by Vitest's own split by path, which can leave one shard with far more
  of the slow files than another. A file not in the weights is still run, by
  exactly one shard. Only the device shards build or restore the `marfa`
  binary and the Node module.
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
