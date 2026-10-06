#!/usr/bin/env bash
# Cargo's runner (`.cargo/config.toml`). Kernel limits hold after the test
# runner is gone; a runaway query fills the disk through an unlinked SQLite
# temporary file no listing shows. Only test binaries, which live in `deps`.
set -euo pipefail

# Never raises a limit; a refused change fails the run rather than uncapping.
cap() {
  local current
  current="$(ulimit -S "$1")"
  if [[ "${current}" == unlimited || "${current}" -gt "$2" ]]; then
    ulimit "$1" "$2"
  fi
}

if [[ "$(basename "$(dirname "$1")")" == deps ]]; then
  # bash counts in 1024-byte units: 1 GiB.
  cap -f 1048576
  # Processor seconds for the whole binary, every test in it.
  cap -t 600
  # A test that opens a folder lists it in the registry; never the person's.
  # Cargo uses this runner only when run from under `core/`, so marfa-core's
  # own unit tests also keep out of the person's registry in the code.
  if [[ -z "${MARFA_FOLDER_REGISTRY:-}" ]]; then
    MARFA_FOLDER_REGISTRY="$(mktemp -d "${TMPDIR:-/tmp}/marfa-test-registry.XXXXXX")/folders.json"
    export MARFA_FOLDER_REGISTRY
  fi
fi

exec "$@"
