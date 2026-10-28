#!/usr/bin/env bash
# Cargo's runner (`.cargo/config.toml`). Kernel limits hold after the test
# runner is gone; a runaway query fills the disk through an unlinked SQLite
# temporary file no listing shows. Only test binaries, which live in `deps`.
#
# A test run also sends no telemetry, whatever the developer's shell sets: the
# binary under test and every server a test boots inherit this environment, and
# many commands here fail on purpose. A test that wants telemetry sets its own
# environment explicitly (`tests/telemetry.rs` clears it first).
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
  # shellcheck source=no-telemetry.sh
  source "$(dirname "${BASH_SOURCE[0]}")/no-telemetry.sh"
  # A test that opens a folder lists it in the registry; never the person's.
  # Cargo uses this runner only when run from under `core/`, so marfa-core's
  # unit tests also keep out of it in `Registry::located`.
  if [[ -z "${MARFA_FOLDER_REGISTRY:-}" ]]; then
    # Resolve the system temporary parent, whose macOS /var spelling is an alias.
    test_temp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
    registry_dir="$(mktemp -d "${test_temp_parent}/marfa-test-registry.XXXXXX")"
    MARFA_FOLDER_REGISTRY="${registry_dir}/folders.json"
    export MARFA_FOLDER_REGISTRY
  fi
fi

if [[ -z "${registry_dir:-}" ]]; then
  exec "$@"
fi

# Not exec: the directory this run made has to go when the test binary ends,
# or one is left behind for every binary of every run.
trap 'rm -rf "${registry_dir}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
status=0
"$@" || status=$?
exit "${status}"
