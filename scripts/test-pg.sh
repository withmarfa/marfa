#!/usr/bin/env bash
# Boot a throw-away Postgres 17 container, run the server test suite against
# it, tear down. Mirrors the CI-Postgres job's env so dialect-specific bugs
# (boolean coercion differences, PG-only SCHEMA_SQL gaps, etc.) surface
# locally before push.
#
# Container: postgres:17, same creds as the CI workflow.
# Port: assigned by the kernel at bind time and read back afterwards.
#
# The container name carries the invoking shell's PID so concurrent test:pg
# runs across different worktrees / agents don't stomp on each other's
# containers. Pre-PID this script hard-coded `marfa-test-pg` and `55432`; two
# agents running test:pg simultaneously killed each other's containers via the
# `docker rm -f` at start.
#
# The port used to carry the PID too, as `55432 + ($$ % 1000)`. Two shells
# whose pids differ by a multiple of 1000 got the same port and the second
# container failed to start, before a single test had run — a red check
# carrying no information about the branch. That range also sat inside the
# kernel's ephemeral range, so an ordinary outbound connection could take it
# just as easily as another job could.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER_NAME="marfa-test-pg-$$"
# A transaction-mode PgBouncer in front of the same Postgres, because ten
# tests covering the pooled deployment shape could not run without one and
# so had never run anywhere. They need two independent clients landing on
# the SAME backend, which `default_pool_size = 1` produces and a plain
# Postgres cannot: holding a session variable across a reused connection in
# one client is a different property and would not pin the race.
BOUNCER_NAME="marfa-test-pgbouncer-$$"
# Its own network per run, PID-suffixed like the containers, so the pooler
# can reach Postgres by container name and concurrent runs cannot see each
# other's.
NETWORK_NAME="marfa-test-net-$$"
PG_USER="marfa"
PG_PASSWORD="marfa"
PG_DB="marfa_test"
# The pooler suites get a database of their own rather than sharing
# `marfa_test`. They run DDL directly — a `marfa_app` role and an
# ungranted table, mirroring the shape of the real schema — and
# `marfa_test` is not private: `DATABASE_URL` points at it and other
# tests migrate into it. Sharing it made the suites' teardown try to
# drop the real `auth_session`, which failed on its dependents, and
# would have destroyed a table other tests read had it succeeded.
#
# No PID suffix, unlike everything else here: it lives inside this run's own
# PID-named container on a PID-named network, so another run cannot reach it.
POOLER_DB="marfa_pooler_test"
# Pinned by digest rather than floating on `latest`, matching `postgres:17`
# beside it. CI re-pulls on every run, so an upstream change to this image's
# environment handling would turn a green check red with no repo change,
# surfacing as "PgBouncer did not proxy a query" on an unrelated pull
# request: a red check carrying no information about the branch, which is
# the thing the port scheme above was rewritten to stop producing.
# PgBouncer 1.25.2.
BOUNCER_IMAGE="edoburu/pgbouncer@sha256:4c1ca296ef525f108f5d3552cc337c0c09587cf8dae7f0067fd93349e47dc1cd"

if ! docker info >/dev/null 2>&1; then
  # In CI this script IS the Postgres coverage, so a missing Docker is a
  # failure. Skipping would report green for a dialect nothing exercised,
  # which is the failure mode the hosted service container never had.
  if [ -n "${CI:-}" ]; then
    echo "✗ Docker is not available, so the Postgres suite cannot run." >&2
    echo "  This is CI, where this script is the only Postgres coverage." >&2
    exit 1
  fi
  echo "⊘ Docker is not running, skipping test:pg." >&2
  echo "  To run these locally, start OrbStack / Docker Desktop and retry." >&2
  exit 0
fi

# Set once the suite is running, so cleanup can stop it. Empty before then.
TEST_PID=""
# Set only while the image pull is in flight, for the same reason.
PULL_PID=""
# The trap fires on a signal AND again on the exit that signal causes, and
# the second pass would report a teardown that already happened.
CLEANED=""

cleanup() {
  # Disarm first. The wait loop below can take five seconds, and a runner
  # that escalates during it would otherwise re-enter this function and
  # abandon the teardown half-done — the containers are removed after the
  # loop, so a second signal lands in the worst possible place. Ignoring
  # the signals outright is what makes the rest of this function atomic
  # with respect to them; `CLEANED` only stops the EXIT pass repeating it.
  trap "" INT TERM HUP
  [ -n "${CLEANED}" ] && return 0
  CLEANED=1
  # The suite first. It is talking to the database that is about to be
  # removed, and on a cancellation nobody is reading its output — left
  # running it holds a worker per core against whatever the machine does
  # next. A killed run once left fourteen of these behind.
  #
  # **The whole process group, not the child and its children.** `pnpm`
  # spawns vitest, which spawns a worker per core, so the workers are
  # grandchildren and `pkill -P` never reaches them: signaling only the
  # direct children leaves exactly the tree this is here to collect.
  # `set -m` above put the suite in its own process group, so negating
  # its pid addresses all of it.
  #
  # **The trade-off, stated because it is not free.** Its own group also
  # means the suite is no longer in this script's group, so a signal sent
  # to *our group alone* no longer reaches it incidentally — this cleanup
  # is what stops those workers. Bounded rather than open: the runner's
  # last resort is `KillProcessTree`, which walks the parent/child map and
  # kills children before parents rather than signalling a group, so it
  # still collects them. What the change does cost is a manual
  # `kill -KILL -<pgid>` against this script, which would now leave them.
  # The same wait-then-KILL escalation the suite gets below. A `docker
  # pull` mid-layer does not stop on a TERM promptly, and a cleanup that
  # only asks leaves it running against a network this function is about
  # to remove.
  if [ -n "${PULL_PID}" ] && kill -0 "${PULL_PID}" 2>/dev/null; then
    kill -TERM -- "-${PULL_PID}" 2>/dev/null || kill -TERM "${PULL_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${PULL_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-${PULL_PID}" 2>/dev/null || kill -KILL "${PULL_PID}" 2>/dev/null || true
  fi
  if [ -n "${TEST_PID}" ] && kill -0 "${TEST_PID}" 2>/dev/null; then
    kill -TERM -- "-${TEST_PID}" 2>/dev/null || kill -TERM "${TEST_PID}" 2>/dev/null || true
    # Give it a moment to go before pulling the database out from under it.
    for _ in 1 2 3 4 5; do
      kill -0 "${TEST_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-${TEST_PID}" 2>/dev/null || kill -KILL "${TEST_PID}" 2>/dev/null || true
  fi
  echo "→ Tearing down ${BOUNCER_NAME} and ${CONTAINER_NAME}"
  # -v matters: the postgres image declares a VOLUME, so every run mints an
  # anonymous volume, and removing the container without -v orphans it at
  # roughly 110 MB a run. The --rm on docker run cannot be relied on for
  # this either, because this explicit removal racing it wins, and then
  # nothing deletes the volume.
  docker rm -f -v "${BOUNCER_NAME}" >/dev/null 2>&1 || true
  docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  # Last, and only after both are gone: a network with an attached container
  # refuses to be removed, and would then leak one per run. Reported rather
  # than swallowed, because it is the final resource released and the name
  # carries this run's PID, so nothing later can reclaim it.
  docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 \
    || echo "  warning: could not remove ${NETWORK_NAME}; remove it by hand." >&2
}
# EXIT alone does not cover a killed run, and a killed run is the one that
# most needs this: nobody is watching the output to notice what was left
# behind. A stopped matrix left a Postgres, a pooler, an anonymous volume
# and a network running, and the networks accumulate invisibly because
# their names carry the shell's PID, so nothing later can tell an orphan
# from a live run's and nothing dares delete either.
#
# The runner's cancellation sequence, from `actions/runner`
# `src/Runner.Sdk/ProcessInvoker.cs`: `CancelAndKillProcessTree` sends
# SIGINT, waits `_sigintTimeout` (7500 ms), sends SIGTERM, waits
# `_sigtermTimeout` (2500 ms), then `KillProcessTree`. **SIGINT is first,
# not SIGTERM**, and both are delivered to a single pid — `kill(_proc.Id,
# signal)` — so they reach this shell and nothing else. That is why the
# INT trap matters most in practice and why the reproduction signalled
# the script's pid rather than its group.
#
# `HUP` alongside the other two: a runner tearing its session down is
# another way this script is ended without exiting, and an untrapped fatal
# signal does not run the EXIT trap.
#
# **Trapping is not enough on its own, which is what this run's history
# missed.** Bash defers a trap until the foreground command finishes, so
# with the suite running in the foreground a `TERM` was recorded and not
# acted on: the script kept going, the runner's grace period expired, and
# the `KILL` that followed ran no trap at all. Measured — fifteen seconds
# after a `TERM` the script was still running tests, and the `KILL` left
# both containers, the network and fourteen vitest processes behind. The
# suite therefore runs in the background and is waited on below, so the
# handler runs the moment the signal arrives.
# **The signal traps exit; the EXIT trap only cleans up.** A handler that
# returns resumes the script where it was interrupted, so a `TERM` during
# the readiness loop tore the container down and then went on polling for
# it — measured, and the reason a plain `trap cleanup ... TERM` is not
# enough on its own. `CLEANED` makes the EXIT pass that follows a no-op.
# 128 + signal number is the conventional status for each.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

# Remove anything a crashed previous run left behind under these names.
docker rm -f -v "${BOUNCER_NAME}" >/dev/null 2>&1 || true
docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true

# Pull before the run, backgrounded and waited on like everything else
# that can take a while. A `docker run` against a cold cache pulls in the
# foreground, and a foreground command defers the trap for as long as the
# pull takes — which on a fresh runner is the longest unprotected window
# in this script. Failures are ignored: `docker run` will pull anyway, and
# a registry hiccup here should not fail a suite that could still run from
# a warm cache.
echo "→ Pulling images if needed"
set -m
(docker pull postgres:17 >/dev/null 2>&1 || true
 docker pull "${BOUNCER_IMAGE}" >/dev/null 2>&1 || true) &
PULL_PID=$!
set +m
wait "${PULL_PID}" || true
PULL_PID=""

docker network create "${NETWORK_NAME}" >/dev/null

echo "→ Starting ${CONTAINER_NAME} (postgres:17)"
# `-c max_connections=500` raises the per-cluster connection cap above PG's
# default 100. With the template-DB pattern (one cloned DB per test file)
# and parallel test workers, each worker keeps its own pool open — peak
# concurrency around CPU-count test files × ~10 connections per pool can
# blow past 100 cleanly. 500 is well above what local + CI workloads need.
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  --network "${NETWORK_NAME}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "0:5432" \
  postgres:17 \
  postgres -c max_connections=500 >/dev/null

# Read back what the kernel assigned. `docker port` prints a line per address
# family, so take the IPv4 one; everything below connects over localhost.
# `sed -n '1s/.*://p'` rather than a grep for a particular bind address. Two
# reasons. It exits 0 on no match, so `set -euo pipefail` cannot kill the
# script at this assignment before the check below can report anything -- a
# grep here exits 1 on no match and pipefail propagates it. And the last-colon
# rule reads `0.0.0.0:N`, `[::]:N` and `127.0.0.1:N` identically, so a daemon
# configured to publish on loopback still works instead of hard-failing.
PG_PORT="$(docker port "${CONTAINER_NAME}" 5432/tcp | sed -n '1s/.*://p')"
if [ -z "${PG_PORT}" ]; then
  echo "✗ Postgres started but no host port was published for 5432/tcp." >&2
  docker port "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
echo "  published on port ${PG_PORT}"

echo "→ Waiting for Postgres to accept connections"
# `pg_isready` only checks the postmaster is listening — it returns OK
# before the cluster is actually ready to serve queries, causing
# transient "the database system is starting up" / ECONNREFUSED errors
# on the first connections. Gate on an actual `SELECT 1` against the
# target database (cheap; the only fully reliable readiness signal).
# https://www.postgresql.org/docs/current/app-pg-isready.html
for i in {1..60}; do
  if docker exec "${CONTAINER_NAME}" psql -U "${PG_USER}" -d "${PG_DB}" -c "SELECT 1" >/dev/null 2>&1; then
    echo "  ready (after ${i}s)"
    break
  fi
  if [ "${i}" = "60" ]; then
    echo "✗ Postgres did not come up in 60s" >&2
    docker logs "${CONTAINER_NAME}" >&2
    exit 1
  fi
  sleep 1
done

# Prove the port we are about to advertise actually reaches something, from the
# host, which the readiness gate above does not: it runs `docker exec` inside
# the container, so it reports ready whether or not the published mapping
# works. Without this a shadowed mapping surfaces much later as a hang in
# whatever ran next.
#
# What it does not prove: that the listener is *our* container. Docker's
# allocator has no visibility into macOS-side port usage, so a port already
# held on the host could in principle be published over. That is far narrower
# than the old behaviour -- the allocator starts near 32768 while the host's
# ephemeral range starts at 49152 -- but it is not zero, and pretending
# otherwise is how the previous version read as safe.
if ! (echo > /dev/tcp/127.0.0.1/"${PG_PORT}") >/dev/null 2>&1; then
  echo "✗ Postgres is ready inside the container but ${PG_PORT} does not accept" >&2
  echo "  connections from the host, so the published mapping is not working." >&2
  exit 1
fi

echo "→ Creating ${POOLER_DB} for the pooler suites"
docker exec "${CONTAINER_NAME}" psql -U "${PG_USER}" -d "${PG_DB}" \
  -c "CREATE DATABASE \"${POOLER_DB}\"" >/dev/null

echo "→ Starting ${BOUNCER_NAME} (transaction-mode PgBouncer)"
# `default_pool_size = 1` is the whole point rather than a size choice: the
# premise case needs two independent clients to land on one backend, and with
# a larger pool they get one each, a session-scoped lock excludes correctly,
# and the case fails reporting a pooler-safe database rather than a
# misconfigured fixture.
#
# `AUTH_TYPE=scram-sha-256` keeps the password in the generated userlist as
# plaintext, which is what lets the pooler authenticate onward to a Postgres
# 17 that stores SCRAM verifiers. The md5 default writes a hash it cannot
# then present to the server.
docker run -d --rm \
  --name "${BOUNCER_NAME}" \
  --network "${NETWORK_NAME}" \
  -e "DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@${CONTAINER_NAME}:5432/${POOLER_DB}" \
  -e "POOL_MODE=transaction" \
  -e "DEFAULT_POOL_SIZE=1" \
  -e "MAX_CLIENT_CONN=200" \
  -e "AUTH_TYPE=scram-sha-256" \
  -p "0:5432" \
  "${BOUNCER_IMAGE}" >/dev/null

BOUNCER_PORT="$(docker port "${BOUNCER_NAME}" 5432/tcp | sed -n '1s/.*://p')"
if [ -z "${BOUNCER_PORT}" ]; then
  echo "✗ PgBouncer started but no host port was published for 5432/tcp." >&2
  docker port "${BOUNCER_NAME}" >&2 || true
  exit 1
fi
echo "  published on port ${BOUNCER_PORT}"

echo "→ Waiting for PgBouncer to proxy a query"
# Gate on a query that reaches Postgres THROUGH the pooler, not on the port
# accepting. PgBouncer listens immediately and fails the onward connection
# later, so a TCP check reports ready for a pooler that cannot reach
# anything, and the ten tests then fail on authentication looking like a
# defect in the code they cover.
# Probed from the Postgres container rather than a throwaway one. A
# throwaway attaches to the run's network, and if the script dies while one
# is still attached the network keeps an active endpoint, `docker network rm`
# fails, and the name carries this run's PID so no later run can ever reclaim
# it. Docker caps user-defined bridge networks at around thirty-one, so that
# leak eventually breaks `test:pg` for everything on the machine. The
# Postgres container is already on the network, already has `psql`, and is
# already released by the trap.
for i in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" \
       psql "postgres://${PG_USER}:${PG_PASSWORD}@${BOUNCER_NAME}:5432/${POOLER_DB}" \
       -c "SELECT 1" >/dev/null 2>&1; then
    echo "  ready (after ${i}s)"
    break
  fi
  if [ "${i}" = "30" ]; then
    echo "✗ PgBouncer did not proxy a query in 30s" >&2
    docker logs "${BOUNCER_NAME}" >&2
    exit 1
  fi
  sleep 1
done

# Prove the pooler's published port reaches it from the host, which the
# probe above does not: that runs inside the network by container name,
# while the suites connect to localhost. Postgres gets the same check for
# the same reason. Without it a shadowed mapping surfaces as ten failing
# tests rather than as the fixture error it is.
if ! (echo > /dev/tcp/127.0.0.1/"${BOUNCER_PORT}") >/dev/null 2>&1; then
  echo "✗ PgBouncer is proxying inside the network but ${BOUNCER_PORT} does not" >&2
  echo "  accept connections from the host, so its published mapping is not working." >&2
  exit 1
fi

echo "→ Running server tests (Postgres)"
# Uses the root `pnpm test` (vitest projects config); scoping to server alone
# breaks config resolution when the root vitest.config.ts owns the projects
# list. The server tests are the only ones that exercise the dialect env vars.
#
# Arguments are forwarded to vitest as file filters, so a change to one
# dialect-specific file can be exercised without the whole suite. That
# matters on a machine that also runs the CI pool: without it, checking a
# single Postgres-only test costs a full run, and the usual response is to
# skip the check and let CI find out.
#
# Two PG URLs are exported:
#   - DATABASE_URL — historical compat, points at ${PG_DB} (marfa_test).
#     The globalSetup uses it only as a fallback to derive the admin URL.
#   - MARFA_TEST_PG_ADMIN_URL — points at the `postgres` system DB so the
#     globalSetup can CREATE/DROP the test template + per-file clones.
#     Required for the per-file template-database lifecycle that replaced
#     the shared-DB + truncate-on-setup pattern. See
#     packages/server/src/storage/pg/test-template.ts.
#
# Two more point at the pooler, which is what lets the transaction-mode
# suites run at all:
#   - MARFA_TEST_PGBOUNCER_URL — the pooled endpoint.
#   - MARFA_TEST_PGBOUNCER_DIRECT_URL — the same database unpooled, which
#     those suites need to observe what the pooler did to a backend, and
#     which one of them asserts a transaction-mode client refuses to run
#     without.
#
# Both name POOLER_DB rather than the main database, so the DDL those
# suites run cannot reach anything else in the run.
# `set -m` gives the suite its own process group, so the cleanup can
# signal the whole tree rather than only the direct child. Turned off
# again immediately: it is needed for the spawn, not for the wait.
set -m
DB_DIALECT=pg \
  DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}" \
  MARFA_TEST_PG_ADMIN_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres" \
  MARFA_TEST_PGBOUNCER_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${BOUNCER_PORT}/${POOLER_DB}" \
  MARFA_TEST_PGBOUNCER_DIRECT_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${POOLER_DB}" \
  pnpm test "$@" &
TEST_PID=$!
set +m

# `wait` rather than running the suite in the foreground, and that is the
# whole fix: a foreground child makes bash defer every trap until it
# returns, while `wait` is interruptible and lets the handler run at once.
# The assignment on failure is what keeps `set -e` from exiting here
# before the status can be read and re-raised deliberately below.
TEST_STATUS=0
wait "${TEST_PID}" || TEST_STATUS=$?
TEST_PID=""
if [ "${TEST_STATUS}" -ne 0 ]; then
  exit "${TEST_STATUS}"
fi

# Qualified, because the success line is the part that gets pasted into a
# pull request. An unqualified "passed" after a narrowed run reads as the
# whole suite to everybody downstream of it.
if [ "$#" -gt 0 ]; then
  echo "✓ test:pg passed — NARROWED to: $*"
else
  echo "✓ test:pg passed"
fi
