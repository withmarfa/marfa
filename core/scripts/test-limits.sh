#!/usr/bin/env bash
# Cargo runs what it builds through this script (`.cargo/config.toml`), and a
# test binary runs under a ceiling on the size of any file it writes and on
# the processor time it takes. The kernel enforces both, so they hold when
# nothing is watching: a test whose runner is gone is stopped all the same. A
# query that never finishes spills into an unlinked SQLite temporary file,
# which no listing of the disk shows and which otherwise grows until the disk
# is full.
#
# Only test binaries, which Cargo writes into a `deps` directory of whatever
# target directory it builds in. A binary started with `cargo run` runs as it
# is.
set -euo pipefail

# Lowers a limit and never raises one: a machine that already holds a
# tighter ceiling keeps it, and one that refuses the change fails the run
# rather than letting the binary go uncapped.
cap() {
  local current
  current="$(ulimit -S "$1")"
  if [[ "${current}" == unlimited || "${current}" -gt "$2" ]]; then
    ulimit "$1" "$2"
  fi
}

if [[ "$(basename "$(dirname "$1")")" == deps ]]; then
  # 1 GiB, in bash's 1024-byte units. A test that writes more is stopped by
  # SIGXFSZ.
  cap -f 1048576
  # Seconds of processor time for the whole binary, every test in it
  # counted. A test that spends them is stopped by SIGXCPU.
  cap -t 600
fi

exec "$@"
