#!/usr/bin/env bash
# Boot a throw-away Postgres 17 container, run the provided command with
# DATABASE_URL pointing at it, tear down on exit. Used by the SCHEMA_SQL
# generator (and its dump-equality test) to apply migrations against a real
# Postgres before introspecting the resulting schema.
#
# Distinct from scripts/test-pg.sh (which exists at the repo root and boots a
# container for the server test suite). Both can run concurrently: each lets
# Docker assign the host port and uses its own container name.
#
# Container: postgres:17 — matches the test:pg container and the
# createTestContext() defaults. CI boots this same script rather than a
# service container, so there is one definition instead of two that can drift.
#
# Usage: bash packages/server/scripts/with-temp-pg.sh <command> [args...]
#
# For NON-INTERACTIVE commands only. The command is run in the background
# and waited on, so that the script can service a signal rather than
# deferring it until the command returns — which means the command does
# not own the terminal and cannot reliably read stdin. Every caller today
# is a generator or a smoke test; a command that prompts would hang.
#
# Skips gracefully (exit 0, ⊘ message) when Docker is not running locally, so a
# contributor without it is not blocked. Under CI it fails instead: there this
# wrapper is the only database, and a skip would report green for work that
# never ran.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  # In CI this wrapper IS the Postgres, so a missing Docker is a failure.
  # Skipping would let the caller report success without ever reaching a
  # database, which for a drift check means green on a diff nobody generated.
  if [ -n "${CI:-}" ]; then
    echo "✗ Docker is not available, so no Postgres could be started." >&2
    echo "  This is CI, where this wrapper provides the database." >&2
    exit 1
  fi
  echo "⊘ Docker is not running, skipping with-temp-pg." >&2
  echo "  To run locally, start OrbStack / Docker Desktop and retry." >&2
  exit 0
fi

# The host port is chosen by the kernel at bind time, not by us beforehand.
#
# This used to probe for a free port and bind it in a later step, which left a
# window: any process taking the port in between turned a green branch red with
# `Bind for 0.0.0.0:<port> failed: port is already allocated`, exit 125. The
# retry loop did not help, because it retried the probe and the probe had
# succeeded. Worse, the range it probed (50000-60000) sits inside the kernel's
# own ephemeral range, so the thief was not only a concurrent CI job but any of
# the outbound connections a full test run opens by the thousand.
#
# Publishing on port 0 hands the choice to the only allocator that can make it
# atomically, then `docker port` reads back what was assigned.
PG_USER="marfa"
PG_PASSWORD="marfa"
PG_DB="marfa_schema_dump"
# The name can no longer carry the port, because the port does not exist until
# the container does. The pid plus a nonce keeps concurrent runs distinguishable
# in `docker ps`, which is what the port was providing.
CONTAINER_NAME="marfa-schema-dump-pg-$$-${RANDOM}"

# Set once the command is running, so cleanup can stop it. Empty before then.
CHILD_PID=""
# Set only while the image pull is in flight, for the same reason.
PULL_PID=""
# The trap fires on a signal AND again on the exit that signal causes.
CLEANED=""

cleanup() {
  # Disarm first, so a second signal during the wait loop below cannot
  # re-enter and abandon the teardown half-done. `CLEANED` only stops the
  # EXIT pass repeating it.
  trap "" INT TERM HUP
  [ -n "${CLEANED}" ] && return 0
  CLEANED=1
  # The command first: it is talking to the database about to be removed,
  # and on a cancellation nobody is reading its output.
  if [ -n "${PULL_PID}" ] && kill -0 "${PULL_PID}" 2>/dev/null; then
    kill -TERM -- "-${PULL_PID}" 2>/dev/null || kill -TERM "${PULL_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${PULL_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-${PULL_PID}" 2>/dev/null || kill -KILL "${PULL_PID}" 2>/dev/null || true
  fi
  # The whole process group: the command may spawn its own children, and
  # signaling only the direct child leaves them behind. The trade-off is
  # the same one `test-pg.sh` records: the command's own group is no
  # longer this script's, so nothing but this cleanup stops it, and an
  # untrappable KILL of our group alone would leave it running.
  if [ -n "${CHILD_PID}" ] && kill -0 "${CHILD_PID}" 2>/dev/null; then
    kill -TERM -- "-${CHILD_PID}" 2>/dev/null || kill -TERM "${CHILD_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${CHILD_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-${CHILD_PID}" 2>/dev/null || kill -KILL "${CHILD_PID}" 2>/dev/null || true
  fi
  # -v matters: the postgres image declares a VOLUME, so every run mints an
  # anonymous volume, and removing the container without -v orphans it.
  docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
# `HUP` alongside the other two: a runner tearing its session down ends
# this script without exiting, and an untrapped fatal signal does not run
# the EXIT trap.
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

# Pulled before the run, backgrounded and waited on like the command
# below. A `docker run` against a cold cache pulls in the foreground, and
# a foreground command defers every trap for as long as the pull takes —
# on a fresh runner the longest unprotected window in this script, and
# the same one `test-pg.sh` closes. Failures are ignored: `docker run`
# pulls anyway, and a registry hiccup should not fail a job that could
# still run from a warm cache.
echo "→ Pulling postgres:17 if needed" >&2
set -m
(docker pull postgres:17 >/dev/null 2>&1 || true) &
PULL_PID=$!
set +m
wait "${PULL_PID}" || true
PULL_PID=""

echo "→ Starting ${CONTAINER_NAME} (postgres:17)" >&2
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "0:5432" \
  postgres:17 >/dev/null

# Read back the assignment. `docker port` prints one line per address family
# (0.0.0.0 and [::]), so take the IPv4 line and keep the part after the last
# colon. Everything here connects over 127.0.0.1.
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
echo "  published on port ${PG_PORT}" >&2

# Wait for ready. pg_isready alone races against the postgres entrypoint's
# initdb post-start phase — it can briefly report ready while the cluster is
# still in startup recovery, surfacing as `57P03 the database system is
# starting up` on the first real connection. Gate on an actual `SELECT 1`
# round-trip via psql inside the container so we only break out when the
# server is genuinely accepting queries.
echo -n "  waiting for postgres to be ready" >&2
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1 \
     && docker exec "${CONTAINER_NAME}" psql -U "${PG_USER}" -d "${PG_DB}" -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo " ✓" >&2
    break
  fi
  echo -n "." >&2
  sleep 0.5
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

export DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
# Surface the container name so the generator can `docker exec` into it for
# version-matched pg_dump (avoids a host pg_dump install requirement).
export PG_CONTAINER_NAME="${CONTAINER_NAME}"

# Run the command as a child, NOT via `exec`. `exec` replaces this shell with
# the command, and a shell that no longer exists cannot run its EXIT trap, so
# the container above outlives every invocation. That is not hypothetical: it
# leaked one postgres:17 container per run for days, and `--rm` does not help
# because it only fires when a container stops and nothing was left to stop it.
#
# `set -e` would exit here before the status could be captured, so the failure
# is caught explicitly. Either way the trap runs and the container goes.
#
# Backgrounded and waited on rather than run in the foreground, which is the
# half the trap above cannot supply on its own: **bash defers a trap until
# the foreground command finishes**, so a `TERM` arriving mid-command was
# recorded and not acted on, and a runner escalating to `KILL` then ran no
# teardown at all. `wait` is interruptible, so the handler runs at once.
STATUS=0
# `set -m` gives the command its own process group so the cleanup can
# signal the whole tree; off again straight after the spawn.
set -m
"$@" &
CHILD_PID=$!
set +m
wait "${CHILD_PID}" || STATUS=$?
CHILD_PID=""
exit "$STATUS"
