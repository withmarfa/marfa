#!/usr/bin/env bash
# Refuses a folder that is not exactly the named files, each non-empty.
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
