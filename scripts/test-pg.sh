#!/usr/bin/env bash
# Boot a throw-away Postgres 17 container, run the server test suite against
# it, tear down. Mirrors the CI-Postgres job's env so dialect-specific bugs
# (boolean coercion differences, PG-only SCHEMA_SQL gaps, etc.) surface
# locally before push.
#
# Container: postgres:17, same creds as the CI workflow.
# Port: 55432 (deliberately non-standard to avoid collision with any local pg).
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER_NAME="myme-test-pg"
PG_PORT="55432"
PG_USER="myme"
PG_PASSWORD="myme"
PG_DB="myme_test"

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker is not running. Start Docker Desktop / OrbStack / your daemon." >&2
  echo "  test:pg boots a throw-away Postgres 17 container to mirror CI's" >&2
  echo "  Postgres job. There is no SQLite fallback in this script — that's" >&2
  echo "  test:fresh-sqlite." >&2
  exit 1
fi

cleanup() {
  echo "→ Tearing down ${CONTAINER_NAME}"
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Remove any prior container (e.g. from a crashed previous run)
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

echo "→ Starting ${CONTAINER_NAME} (postgres:17) on port ${PG_PORT}"
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "${PG_PORT}:5432" \
  postgres:17 >/dev/null

echo "→ Waiting for Postgres to accept connections"
for i in {1..30}; do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
    echo "  ready (after ${i}s)"
    break
  fi
  if [ "${i}" = "30" ]; then
    echo "✗ Postgres did not come up in 30s" >&2
    docker logs "${CONTAINER_NAME}" >&2
    exit 1
  fi
  sleep 1
done

echo "→ Running server tests (Postgres)"
# Uses the root `pnpm test` (vitest projects config); scoping to server alone
# breaks config resolution when the root vitest.config.ts owns the projects
# list. The server tests are the only ones that exercise the dialect env vars.
STORAGE_DIALECT=pg \
  DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}" \
  pnpm test

echo "✓ test:pg passed"
