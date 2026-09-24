#!/usr/bin/env bash
# Refuse an npm tarball missing a file its package ships, or holding it
# empty. A pack that found no build still succeeds, with package.json and
# whatever else is not built, so what a package ships is asked for by name.
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
