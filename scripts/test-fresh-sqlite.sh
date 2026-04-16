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

echo "→ Wiping test-DB artefacts under packages/server/data/"
# test-prefixed and -test-suffixed SQLite files, plus their WAL/SHM siblings
rm -f \
  packages/server/data/test-*.db \
  packages/server/data/test-*.db-shm \
  packages/server/data/test-*.db-wal \
  packages/server/data/*-test.db \
  packages/server/data/*-test.db-shm \
  packages/server/data/*-test.db-wal

echo "→ Running server tests (SQLite)"
# The root `pnpm test` uses vitest projects (packages/*) which is how CI
# runs the suite. Running scoped to the server package fails config
# resolution when the root vitest.config.ts owns the projects list.
pnpm test

echo "✓ test:fresh-sqlite passed"
