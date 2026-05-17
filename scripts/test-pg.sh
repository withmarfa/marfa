#!/usr/bin/env bash
# Boot a throw-away Postgres 17 container, run the server test suite against
# it, tear down. Mirrors the CI-Postgres job's env so dialect-specific bugs
# (boolean coercion differences, PG-only SCHEMA_SQL gaps, etc.) surface
# locally before push.
#
# Container: postgres:17, same creds as the CI workflow.
# Port: 55432 (deliberately non-standard to avoid collision with any local pg).
#
# Container name + port carry the invoking shell's PID so concurrent
# test:pg runs across different worktrees / agents don't stomp on each
# other's containers. Pre-PID this script hard-coded `myme-test-pg`
# and `55432`; two agents running test:pg simultaneously killed each
# other's containers via the `docker rm -f` at start. With PID
# suffixing each invocation owns its own container + port.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER_NAME="myme-test-pg-$$"
# Port: a deterministic-per-PID offset above 55432 so concurrent runs
# don't collide on the host port either. Modulo keeps it in a sane
# range (55432-56431); collisions across PIDs spaced exactly 1000 apart
# are vanishingly unlikely in practice.
PG_PORT=$((55432 + ($$ % 1000)))
PG_USER="myme"
PG_PASSWORD="myme"
PG_DB="myme_test"

if ! docker info >/dev/null 2>&1; then
  echo "⊘ Docker is not running — skipping test:pg." >&2
  echo "  Postgres-dialect tests still run in GitHub Actions on every PR." >&2
  echo "  To run them locally, start OrbStack / Docker Desktop and retry." >&2
  exit 0
fi

cleanup() {
  echo "→ Tearing down ${CONTAINER_NAME}"
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Remove any prior container (e.g. from a crashed previous run)
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

echo "→ Starting ${CONTAINER_NAME} (postgres:17) on port ${PG_PORT}"
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
  -p "${PG_PORT}:5432" \
  postgres:17 \
  postgres -c max_connections=500 >/dev/null

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
#   - DATABASE_URL — historical compat, points at ${PG_DB} (myme_test).
#     The globalSetup uses it only as a fallback to derive the admin URL.
#   - MYME_TEST_PG_ADMIN_URL — points at the `postgres` system DB so the
#     globalSetup can CREATE/DROP the test template + per-file clones.
#     Required for the per-file template-database lifecycle that replaced
#     the shared-DB + truncate-on-setup pattern (PR 1 of the May 2026 CI/test
#     audit). See packages/server/src/storage/pg/test-template.ts.
STORAGE_DIALECT=pg \
  DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}" \
  MYME_TEST_PG_ADMIN_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres" \
  pnpm test

echo "✓ test:pg passed"
