#!/usr/bin/env bash
# Write one checksum file for the command line archives of a release, in the
# `sha256sum` format (`<hash>  <file>`), so `sha256sum -c` and
# `shasum -a 256 -c` verify them where they sit. Then check what was written
# against the files.
#
#   write-checksums.sh <checksum file> <archive>...   (run in the folder)
set -euo pipefail

out="$1"
shift
: >"$out"
for archive in "$@"; do
  if [ ! -s "$archive" ]; then
    echo "::error::$archive is missing or empty."
    exit 1
  fi
  printf '%s  %s\n' "$(sha256sum "$archive" | cut -d' ' -f1)" "$archive" >>"$out"
done
sha256sum -c "$out"
