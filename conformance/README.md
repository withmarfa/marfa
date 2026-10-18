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

| Command                                                          | What it does                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `up [--port <n>] [--env K=V ...]`                                | Boots the target with the settings, claims it, mints the fixture keys and writes the env file. Exits 0 once the target answers `/health` and the keys exist.                                                       |
| `restart [--signal TERM\|INT\|KILL] [--env K=V ...]`             | Stops the target with the signal, prints how it ended as `previous exit {"code":..,"signal":..,"ms":..}`, and boots it again on the same data. The URL may change.                                                 |
| `down`                                                           | Stops the target and removes its data.                                                                                                                                                                             |
| `status`                                                         | Exits 0 when the target is running, and prints its URL.                                                                                                                                                            |
| `refused [--node-env <name>] [--env K=V ...]`                    | Boots with settings the target must refuse, as the `NODE_ENV` named when `--node-env` is given, and waits for it to end. Exits 0 when it ended; its exit record and log are in the state directory.                |
| `clock advance <ms>`                                             | Moves the target's clock forward. A negative or fractional step is refused and the exit status is 1.                                                                                                               |
| `fault set <name>[=<arg>]`, `fault clear [<name>]`, `fault list` | Sets or clears a named fault. `list` prints `{"faults":[{"name":..,"arg":..,"waiting":..,"fired":..}]}`, where `waiting` counts the callers held at a `hold` fault and `fired` the times a `fail` fault has acted. |

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

The target's stored times and expiry checks follow the clock, including the
times a component it builds on sets for itself. The sign-in library's sessions,
opaque access and refresh tokens, authorization links and registrations are stamped and judged by the
target's clock, so a fixture that moves the clock ages them too and writes none
of those times. The server does this by making the process's `Date` follow the
offset when the hooks are on, before it creates the sign-in library; a second
implementation provides the same by whatever means its components allow.

Timers and elapsed-time measures stay on real time: a job's deadline, a busy
wait, a stream's heartbeat and the server's uptime do not follow the clock. A
fixture moves the clock and then runs the job it tests with
`POST /housekeeping/{name}/run`.

The model is "time passed": the target and every party the harness controls
use the stated clock. A fixture's process keeps its real clock, so clients
apply `FreshServer.clockOffsetMs` (the boot offset plus subsequent advances)
when creating or checking protocol timestamps. `MarfaClient` and `DpopClient`
accept `serverClockOffsetMs` as a number or a callback; use the callback when
a client outlives a clock advance. DPoP proofs and other client assertions,
explicit HTTP `Date` headers and signed timestamps must use that stated time.
The server's DPoP proof-age checks remain unchanged: a real-time proof is stale
after the stated time advances beyond its validity window.

Webhook receivers and OAuth relying parties in the harness also use the
stated clock. Webhook signature timestamps, event-body timestamps, absolute
`Retry-After` dates and retry scheduling follow it. OAuth ID-token `iat`,
`exp`, `nbf` (when present) and `auth_time` claims follow it, just as opaque
tokens and sessions do.

Packed-attestation certificate validity follows the stated clock. A fixture
that moves the clock must issue any certificates it presents on that clock,
with validity dates covering the intended presentation time. Existing passkey
fixtures use `none` attestation and present no certificate.

Only peers the harness cannot move stay on real time:

- S3 requests and store-signed blob links use the object store's real clock.
  Their stated lifetime elapses in real seconds, including when the target
  starts ahead or advances again. The adapter runs the SDK, its credential
  providers, retries, uploads and presigner in an isolated real-time context.
  The installed SDK's `systemClockOffset` affects request signing but not
  presigning; a constructor offset alone would also miss later clock moves.
  Links served by the target itself still expire on the target's clock.
- OTLP export retries and PostHog transport use real time because a deployed
  telemetry collector is outside the harness's clock control. A fixture
  standing in for that external collector uses real time for transport
  responses, including `Retry-After`. Marfa log records keep their stated-clock
  event timestamps; those timestamps are observations, not credential
  lifetimes. Traces use the runtime's monotonic time base.

Node's automatic HTTP `Date` headers and native TLS certificate checks use
the runtime's real clock, unaffected by the JavaScript `Date` replacement.
Fixtures that send a protocol timestamp explicitly must set it from the
stated clock rather than use an automatic header as the clock's witness.
Production does not install the shim.

### The contract version

The target reports a contract version in the root's `contract`, in
`X-Marfa-Contract` and as the document's `info.version`. `up` and `restart`
take `--env MARFA_TEST_CONTRACT_VERSION=<n>`, a whole number, to boot the
target onto another version for that boot alone: the boot after it is back on
the target's own. The setting is refused unless the hooks are on. A fixture
uses it to show what a change of contract does to what the target kept, such as
the answer stored for a repeated request.

### Faults

A fault is named for where it acts, lives in the target's memory, and is gone
when the target starts. `FreshServer.stop()` clears the faults a fixture set.
A name is `hold:<point>`, `fail:<point>`, `deadline:<job>` or `free:<volume>`, and the points
are the ones below: the target refuses any other name, an argument a point does
not take, and a job it has not registered. A refused fault is never armed, so a
typo cannot pass for one. A fault set again under the same name starts again.

A `hold` fault makes the target wait at the point until the fault is cleared.

| Name                         | What it does                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold:housekeeping:<job>`    | A run of the job waits at its start until the fault is cleared.                                                                                                                                                           |
| `hold:version-thinning:item` | The `version-thinning` job waits, for each item it has chosen to thin, before it removes anything from the item.                                                                                                          |
| `deadline:<job>=<ms>`        | Shortens the run deadline of the job.                                                                                                                                                                                     |
| `hold:blob-orphans:purge`    | A run of `blob-orphans` waits, for each blob it has chosen to purge, before it purges the blob.                                                                                                                           |
| `hold:restore:before-commit` | A restore waits with every row written and the bytes placed, before it commits.                                                                                                                                           |
| `free:<volume>=<bytes>`      | The target reads that many bytes of free space on the volume, `database` or `blobs`, until the fault is cleared.                                                                                                          |
| `hold:stream-open`           | A request for `GET /events`, with or without `copy=1`, waits at the door of the stream, after it was authenticated and before the target has built the stream.                                                            |
| `hold:stream-head`           | The read of the log's head that a stream makes as it opens waits. The bound the stream puts on that read, five seconds, still runs: an event stream then goes on with no head announced and a copy stream ends.           |
| `hold:stream-replay`         | A stream resumed from a cursor waits before each page of the log its replay reads, after it announced its position.                                                                                                       |
| `hold:stream-drain`          | A stream waits after its replay, or at once where it has none, before it delivers the frames it held while it opened and announces `stream_live`.                                                                         |
| `hold:announce`              | A write's events wait after the write commits, before the target tells its open streams of them. Announcements of later writes wait behind them, in order.                                                                |
| `hold:read-snapshot`         | A conditional read, one that names `X-Marfa-Read-View`, waits inside the snapshot it reads from, after the target has judged the read view and before the door reads. The snapshot's own bound, five seconds, still runs. |
| `unfold-deadline=<ms>`       | Shortens the 1,000 ms one series may take to unfold, so a fixture shows that a series past the time bound is left out without needing a rule that is slow enough. It tests the bound, not the 1,000 ms.                   |
| `hold:webhook-schedule:queued` | A run of the `webhook-schedule` job that has queued deliveries waits, before it records its place in the event log.                                                                                                                                                                         |
| `resolve:<hostname>=<answers>` | Makes an outbound webhook delivery resolve the name to the addresses scripted. `<answers>` has one answer for each lookup of the name, separated by `;`, each a list of addresses separated by `,`, and the last answer repeats. The address check still applies to what the fault answers. |

A `free` fault makes the target read the free space it says on one volume, for
the reserve an upload and a restore keep (`blobs`) and for the `disk` component
of `GET /health` (both volumes). Setting it again while a body streams in
changes what the next look at the volume finds, which is how a fixture fills a
volume as the bytes arrive. The check interval is half the reserve, bounded
to 64 KiB through 4 MiB; the target checks when a chunk reaches that interval.
A reserve of zero disables these checks. `<bytes>` is a decimal integer from
0 through 9007199254740991.

Every caller that reaches a held point waits, and `waiting` in the fault's
listing counts them. A hold does not suspend a stream's head-read budget or
a read snapshot's lifetime. A target told to stop releases its faults as the
stop begins, so a request held at `hold:stream-open` resumes after the stop
has begun. Fixtures use this to open a stream during shutdown.

A `fail` fault makes the target fail at the point, once. It acts on the nth
time the point is reached after the fault was set, the first unless the
argument says another: `fail:lock=3` acts on the third write. It then stays
listed with the number of times it acted (`fired`), so a fixture can tell that
it acted, and a fault that never acted is not mistaken for a pass. A fault
that has acted does not act again until it is set again. The statement points (`audit`, `inbound-receipt`, `inbound-cleanup`, `export-read`, `housekeeping:<job>` and `job-row`) count only a statement that failed: a run that reaches the point and runs no statement, such as a job with nothing to do, leaves `fired` at 0 and the fault waiting for a reach that can fail.

`<n>` is a decimal integer from 1 through 1000000, without leading zeros.
`<ms>` is a whole number from 1 through 2147483647. An action argument
starts with a lowercase ASCII letter and contains only lowercase ASCII
letters, digits, underscores, periods, or hyphens. The target validates this
syntax; an action that no write records never fires.

A _write_ is one change made for a caller: a request that changes stored
state, or one entry of a page sent with `atomic: false`. An atomic page is one
write. A write that records an audit entry names it by the entry's `action`
([The audit log](spec/events.md#the-audit-log)), and a write point may take that action in its
argument as `<action>`, for the first such write, or `<action>@<n>`, so a
request that makes other writes first does not shift the count: a
`POST /items/bulk` page under `atomic: false` is a run of `items.bulk` writes,
and `fail:commit=items.bulk@2` fails the second entry's commit. A write point
without an action counts every write.

| Name                            | Reached                                                                                                                     | What it does                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail:lock[=<n>]`               | At the start of each write, before it does any work.                                                                        | The write meets the write lock held by something else for longer than the target waits for it, and is refused as `write_contention`. Nothing of the write is done.                                                                                              |
| `fail:audit[=<write>]`          | When a write records its audit entry.                                                                                       | The statement that stores the entry fails with `SQLITE_IOERR`, as a database fails a statement, so the write and its events roll back. The failure carries the statement and the values it was bound to, as a real one does.                                    |
| `fail:commit[=<write>]`         | When a write that recorded its audit entry commits.                                                                         | The database refuses the commit with `SQLITE_IOERR` and has ended the transaction, so the target cannot prove whether the commit landed. Nothing did land. The write's outcome is unknown, and the audit entry, which the target reads to settle it, is absent. |
| `fail:commit-full[=<write>]`    | The same.                                                                                                                   | As `fail:commit`, refused with `SQLITE_FULL`, the volume having no room.                                                                                                                                                                                        |
| `fail:commit-ack[=<write>]`     | The same.                                                                                                                   | The commit lands and the database reports an error for it with `SQLITE_IOERR`, as when its answer is lost. The write's audit entry is stored, which the target reads to settle the outcome as committed.                                                        |
| `fail:inbound-receipt[=<n>]`    | Before each of the two statements that store an inbound receipt, its metadata and then its body.                            | The statement fails with `SQLITE_IOERR`, carrying its values as `fail:audit` does, and the receipt is not stored.                                                                                                                                               |
| `fail:inbound-cleanup[=<n>]`    | After a run of `inbound-delivery-cleanup` has removed the deliveries it chose.                                              | The run's next statement fails with `SQLITE_IOERR`, so its removal rolls back.                                                                                                                                                                                  |
| `fail:export-read[=<n>]`        | Before each page of items that `GET /export` reads.                                                                         | The page's read fails with `SQLITE_IOERR`. For an NDJSON export the response has begun by then; an archive export reads every page before it sends a byte, so it answers an error.                                                                              |
| `fail:housekeeping:<job>[=<n>]` | At the start of each run of the job, scheduled or asked for.                                                                | The run's first statement fails with `SQLITE_IOERR`. A job that runs no database statement (`heartbeat`) is refused.                                                                                                                                            |
| `fail:job-row[=<n>]`            | Before each row a bulk-action job writes.                                                                                   | The row's first statement fails with `SQLITE_IOERR` and the database ends the chunk's transaction, so the rows of the chunk written before it are lost with it.                                                                                                 |
| `fail:blob-read[=<n>]`          | Before each read of a blob's bytes from a store.                                                                            | The read fails with `EIO` before it opens the bytes.                                                                                                                                                                                                            |
| `fail:blob-read-short[=<n>]`    | When each read of a blob's bytes from a store opens.                                                                        | The read carries the first half of the bytes it would and then ends cleanly, with no error.                                                                                                                                                                     |
| `fail:blob-write[=<n>]`         | Before each placing of a blob's bytes in a store.                                                                           | The write fails with `ENOSPC`, as a volume with no room fails it, and the store keeps no bytes.                                                                                                                                                                 |
| `fail:blob-delete[=<n>]`        | Before each deletion of a blob's bytes from a store.                                                                        | The deletion fails with `EIO` and the store keeps the bytes.                                                                                                                                                                                                    |
| `fail:stream-head[=<n>]`        | Before the read of the log's head that a stream makes as it opens.                                                          | The read fails with `SQLITE_IOERR`.                                                                                                                                                                                                                             |
| `fail:stream-replay[=<n>]`      | Before each page of the log that a stream's replay reads.                                                                   | The read fails with `SQLITE_IOERR`.                                                                                                                                                                                                                             |
| `fail:stream-credential[=<n>]`  | Each time an open stream reads its credential again: before a page of its replay, before a batch of frames, at a heartbeat. | The read fails with `SQLITE_IOERR`.                                                                                                                                                                                                                             |
| `fail:stream-replay-row[=<n>]`  | Each row returned by a plain event stream's replay, in log order, across pages and streams.                                 | The nth row's payload is returned as invalid JSON for that read only. Its ID, stored payload and live announcement remain intact. Copy streams and other log readers do not count or consume this fault.                                                        |
| `fail:edge-source-type[=<n>]`   | Each edge event published by a write, before it is logged or announced.                                                     | The nth event carries no source type in either its stored payload or its live announcement. The source item and edge remain unchanged. A later rollback does not refund the reach.                                                                              |

`<write>` stands for `<n>`, `<action>` or `<action>@<n>`. A target that
cannot fail a point as described says so by refusing its name, and the fixtures
that need it fail rather than skip.

The blob points count a reach by any store and by any caller, including the
target's own background work. With two stores attached, replication reads a
blob from one store and writes it to the other, so it can take a `fail:blob-*`
fault before the request under test reaches the point. A fixture that arms a
blob fault boots a server with the disk store alone (`DISK_ONLY` in
`src/utils/own-blob-server.ts`), or waits until replication has nothing left
to copy, as `blob-cleanup-faults.test.ts` does.

A webhook receiver's answers, status and `Retry-After` header alike, are the
harness's own (`src/utils/webhook-receiver.ts`); the target does not fake them.
The one thing a target scripts for a delivery is a name lookup, with `resolve`,
so that a fixture can answer the same name differently on each lookup and see
which address the delivery connects to.

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

- **The module.** Each fixture loads it in a new process,
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
  among them, answers a promise. The adapter in
  [`src/device/binding-adapter.ts`](src/device/binding-adapter.ts) defines the
  calls and result shapes the fixtures use; the host translates them to the
  module's methods.
- **Folders.** `Folders` provides `add`, `list`, `status`, `sync`,
  `confirmFirstSync`, `confirm`, `restore`, `remove`, and `watch`. Calls
  other than `watch` return promises, including while they ask a watch to let
  a folder go. `watch` returns a subscription synchronously and throws if it
  cannot open the folder. Watch events include `handedOver`, `takenBack`,
  `heldElsewhere`, `removed`, and `unlisted`; its subscription ends once. Each fixture's host
  uses an isolated registry. Debug methods retain an open folder across calls
  (`testOpen`, `testClose`) and expose its existing `testScan`, `testPull`,
  `testSubmitSettingsFile`, `testCatchUp`, `testHydrate`, and `testDrain`
  operations. They let a fixture change the directory or the copy between
  opening the folder and working it.
- **Dispatcher callbacks.** Node delivers callbacks on its event loop. A
  binding that calls listeners on the engine's dispatcher thread is tested
  with `testHooks.probeReentry(core)`: a debug listener runs on that thread,
  attempts a hydration and catch-up, and records their errors in `answers()`.
  `stop()` unregisters it. The fixture proves both calls are refused from the
  callback and that they can succeed outside it.
- **`toldUnreachable`.** `follow` and `watch` take it as an optional last
  argument. It says the caller was last told `serverUnreachable` by an earlier
  one, so the first stream is told `serverReachable` and `serverUnreachable`
  is not told again before.
- **Holds.** The engine reaches named points, and a fixture arms one so that
  the engine waits there until the fixture releases it. `testHooks.hold(point)`
  arms a point, `testHooks.release(point)` lets go of what waits at it and
  disarms it. `testHooks.observe(true)` enables reach counters;
  `testHooks.observe(false)` disables them without resetting their values.
  The binding fixture host enables observation when it loads the module.
  `testHooks.reached(point)` counts the times the engine has reached it while
  observation is enabled, and `testHooks.waiting(point)` counts the calls
  held at it now. A point is reached by a call on the engine's own thread, so
  a fixture waits for `waiting` before it acts on a held call.
  - `hydration-replacing`: after a hydration has begun to replace the copy,
    before it reads the first row.
  - `recovery-drain-asked`, `recovery-drain-found-none`: a held stream's drain,
    when it asks to drain and when it finds no work left.
  - `drain-waiting`: a drain tried to acquire the drain lock and found another
    call holding it. The fixture can hold that waiter while the first drain's
    request remains in flight.
  - `follow-waiting`: a follow that waits for a first hydration.
  - `answer-dropped`: an answer reached a request that nobody waited for.
  - `catalog-replacing`: a refresh of the catalog has written the item types
    and not yet the edge types, inside the transaction that replaces both. A
    reading handle that reads then must answer from the catalog before the
    refresh.
  - `folder-give-way-read`: before a give-way read starts;
    `folder-give-way-withdrawn`: after withdrawing local placement writes,
    inside the transaction that replaces them with the server's placement.
  - `folder-scan-read`: after reading a file's bytes, before recording the
    scan; `folder-status-catalog`: between loading the item and edge catalogs
    from the status snapshot. In debug builds, `folder-status-edge:<id>`
    records each edge type in the loaded status catalog, so a fixture can
    identify its revision even where both catalogs produce the same status.
  - `folder-watch-turn`, `folder-file-changed`, `folder-pass-start`,
    `folder-pass-ended`, `folder-full-scan`, and `folder-quick-scan`: the watch
    loop, a filesystem change, and its pass and scan boundaries.
  - `folder-handover-wait`, `folder-handed-over`, and
    `folder-take-back-wait`: an asking call's wait, its acquired folder, and
    the watch's retry before taking it back. `folders-watch-polled` observes
    the registry supervisor's turn.
- **Failures.** `testHooks.fail(point, on)` makes the engine fail where it
  reaches `point`, and `testHooks.fail(point, false)` stops. The engine counts
  each reach as `testHooks.reached` does. The only point that fails is
  `data-version`, the read a reading handle's watch makes to learn that
  another process saved.
- **Listeners and stores.** `watch` can be called more than once on one working
  copy, and each call is a listener. The host can make a listener block in each
  change, throw from one, and open the store the moment it is told it ended
  (the role the new handle is given says whether the watch had let go of it);
  it can let go of its own core and collect it, so that a watch is the only
  hold left on the store; and it can open the same store to read, in a second
  process (`harness.reader()`), as an app's helper does.
- **A stream the fixture speaks on.** The scripted server's held stream can
  name a `StreamFeed`. The fixture pushes frames to the streams open on it,
  so a change is told after a listener has joined, and the feed counts the
  streams it was asked for.
- **The clock.** `testClock.manual()` sets the clock the engine waits by to
  one that moves only where `testClock.advance(ms)` moves it, and
  `testClock.waits()` lists the waits the engine has asked of it and the clock
  has not reached, each as the milliseconds asked and the milliseconds left.
  Set it before the calls whose waits are read. A wait asked of the system
  clock is not moved to the manual one. `testClock.manual(false)` goes back.
  The wait between held streams, the two measures of a stream's age (how
  long it has been held and how long it has been silent), and a reading
  handle's save polling and read-failure backoff use this clock. Folder
  watch settling, periodic scans, hydration retries, placement rereads, rename
  grace, supervision, and handover deadlines use it too. The rename journal
  uses a wall timestamp derived from the same manual elapsed time. Filesystem
  events remain real; advancing the clock does not manufacture them.

A release build has no `testHooks` and no `testClock`: a fixture that uses
them fails on a module built `--release`, naming that. The module's build
needs the `napi` command its `pnpm-lock.yaml` pins, and the fixtures refuse a
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
