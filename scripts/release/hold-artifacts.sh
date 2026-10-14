#!/usr/bin/env bash
# Refuse a folder of artifacts that is not exactly the files named, each
# non-empty. An upload that only refuses an empty folder would carry a run
# missing one.
#
#   hold-artifacts.sh <file>...   (run in the folder)
set -euo pipefail

expected=$(printf '%s\n' "$@" | LC_ALL=C sort)
found=$(for file in *; do printf '%s\n' "$file"; done | LC_ALL=C sort)
if [ "$found" != "$expected" ]; then
  echo "::error::The artifacts are not the ones named."
  diff <(echo "$expected") <(echo "$found") || true
  exit 1
fi
for file in "$@"; do
  if [ ! -s "$file" ]; then
    echo "::error::$file is empty."
    exit 1
  fi
done
echo "$found"
