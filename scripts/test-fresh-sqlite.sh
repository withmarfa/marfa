#!/usr/bin/env bash
# Wipe vitest + test-DB caches, then run the server test suite against SQLite.
#
# Catches the fresh-DB bootstrap class of regression — when SCHEMA_SQL in
# connection.ts is missing a column, persistent test state from prior runs
# can mask the bug. This script makes every run start from a clean slate.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Wiping vitest cache"
rm -rf \
  node_modules/.vitest \
  packages/*/node_modules/.vitest \
  .vitest-cache \
  packages/*/.vitest-cache

echo "→ Wiping test-DB artifacts under packages/server/data/"
# test-prefixed and -test-suffixed SQLite files, plus their WAL/SHM siblings
rm -f \
  packages/server/data/test-*.db \
  packages/server/data/test-*.db-shm \
  packages/server/data/test-*.db-wal \
  packages/server/data/*-test.db \
  packages/server/data/*-test.db-shm \
  packages/server/data/*-test.db-wal

# Set once the suite is running, so cleanup can stop it. Empty before then.
TEST_PID=""
CLEANED=""

# This script allocates no container, so there is nothing to release — but
# a killed run still orphans the suite's process tree, a worker per core,
# against whatever the machine does next. That is the same tree the
# Postgres script collects, and the same reason: a foreground child defers
# every trap until it returns, so a `TERM` was recorded and not acted on
# and the `KILL` that followed ran nothing.
cleanup() {
  trap "" INT TERM HUP
  [ -n "${CLEANED}" ] && return 0
  CLEANED=1
  if [ -n "${TEST_PID}" ] && kill -0 "${TEST_PID}" 2>/dev/null; then
    kill -TERM -- "-${TEST_PID}" 2>/dev/null || kill -TERM "${TEST_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${TEST_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-${TEST_PID}" 2>/dev/null || kill -KILL "${TEST_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

echo "→ Running server tests (SQLite)"
# The root `pnpm test` uses vitest projects (packages/*) which is how CI
# runs the suite. Running scoped to the server package fails config
# resolution when the root vitest.config.ts owns the projects list.
set -m
pnpm test &
TEST_PID=$!
set +m
TEST_STATUS=0
wait "${TEST_PID}" || TEST_STATUS=$?
TEST_PID=""
if [ "${TEST_STATUS}" -ne 0 ]; then
  exit "${TEST_STATUS}"
fi

echo "✓ test:fresh-sqlite passed"
