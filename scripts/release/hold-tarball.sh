#!/usr/bin/env bash
# Refuses an npm tarball missing a named file or holding it empty; a pack with no build still succeeds.
#
#   hold-tarball.sh <tarball> <path inside the package>...
set -euo pipefail

tarball="$1"
shift
unpacked=$(mktemp -d)
trap 'rm -rf "$unpacked"' EXIT
tar -xzf "$tarball" -C "$unpacked"
for path in "$@"; do
  if [ ! -s "$unpacked/package/$path" ]; then
    echo "::error::$(basename "$tarball") has no $path, or holds it empty:"
    tar -tzf "$tarball"
    exit 1
  fi
done
echo "$(basename "$tarball") holds $*"
