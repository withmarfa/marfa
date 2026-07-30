#!/usr/bin/env bash
# Boot a throw-away Postgres 17 container, run the provided command with
# DATABASE_URL pointing at it, tear down on exit. Used by the SCHEMA_SQL
# generator (and its dump-equality test) to apply migrations against a real
# Postgres before introspecting the resulting schema.
#
# Distinct from scripts/test-pg.sh (which exists at the repo root and boots a
# container for the server test suite). Both can run concurrently — this
# wrapper picks a random free port and uses its own container name.
#
# Container: postgres:17 — matches CI service containers + the test:pg
# container + the createTestContext() defaults.
#
# Usage: bash packages/server/scripts/with-temp-pg.sh <command> [args...]
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

# Pick a free random port in the high range; retry on collision.
pick_port() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local port=$(( 50000 + RANDOM % 10000 ))
    if ! (echo > /dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
  done
  echo "could not find a free port in 50000-60000" >&2
  return 1
}

PG_PORT="$(pick_port)"
PG_USER="marfa"
PG_PASSWORD="marfa"
PG_DB="marfa_schema_dump"
CONTAINER_NAME="marfa-schema-dump-pg-${PG_PORT}"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "→ Starting ${CONTAINER_NAME} (postgres:17) on port ${PG_PORT}" >&2
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "${PG_PORT}:5432" \
  postgres:17 >/dev/null

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
STATUS=0
"$@" || STATUS=$?
exit "$STATUS"
