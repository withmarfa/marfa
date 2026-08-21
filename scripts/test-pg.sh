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
PG_USER="marfa"
PG_PASSWORD="marfa"
PG_DB="marfa_test"

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

cleanup() {
  echo "→ Tearing down ${CONTAINER_NAME}"
  # -v matters: the postgres image declares a VOLUME, so every run mints an
  # anonymous volume, and removing the container without -v orphans it at
  # roughly 110 MB a run. The --rm on docker run cannot be relied on for
  # this either, because this explicit removal racing it wins, and then
  # nothing deletes the volume.
  docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Remove any prior container (e.g. from a crashed previous run)
docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true

echo "→ Starting ${CONTAINER_NAME} (postgres:17)"
# `-c max_connections=500` raises the per-cluster connection cap above PG's
# default 100. With the template-DB pattern (one cloned DB per test file)
# and parallel test workers, each worker keeps its own pool open — peak
# concurrency around CPU-count test files × ~10 connections per pool can
# blow past 100 cleanly. 500 is well above what local + CI workloads need.
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "0:5432" \
  postgres:17 \
  postgres -c max_connections=500 >/dev/null

# Read back what the kernel assigned. `docker port` prints a line per address
# family, so take the IPv4 one; everything below connects over localhost.
PG_PORT="$(docker port "${CONTAINER_NAME}" 5432/tcp | grep '^0\.0\.0\.0:' | head -1 | sed 's/.*://')"
if [ -z "${PG_PORT}" ]; then
  echo "✗ Postgres started but no host port was published for 5432/tcp." >&2
  echo "  This is a Docker port-publishing failure, not port contention." >&2
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

echo "→ Running server tests (Postgres)"
# Uses the root `pnpm test` (vitest projects config); scoping to server alone
# breaks config resolution when the root vitest.config.ts owns the projects
# list. The server tests are the only ones that exercise the dialect env vars.
#
# Two PG URLs are exported:
#   - DATABASE_URL — historical compat, points at ${PG_DB} (marfa_test).
#     The globalSetup uses it only as a fallback to derive the admin URL.
#   - MARFA_TEST_PG_ADMIN_URL — points at the `postgres` system DB so the
#     globalSetup can CREATE/DROP the test template + per-file clones.
#     Required for the per-file template-database lifecycle that replaced
#     the shared-DB + truncate-on-setup pattern. See
#     packages/server/src/storage/pg/test-template.ts.
DB_DIALECT=pg \
  DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}" \
  MARFA_TEST_PG_ADMIN_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres" \
  pnpm test

echo "✓ test:pg passed"
