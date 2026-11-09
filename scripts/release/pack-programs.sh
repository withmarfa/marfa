#!/usr/bin/env bash
# Packs the two programs and their notice into a flat release archive.
#
#   pack-programs.sh <folder holding marfa, marfa-server and NOTICES.txt> <archive>
set -euo pipefail

folder="$1"
archive="$2"

for name in marfa marfa-server NOTICES.txt; do
  if [ ! -s "$folder/$name" ]; then
    echo "::error::$folder/$name is not a non-empty file."
    exit 1
  fi
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$folder/marfa" "$folder/marfa-server" "$folder/NOTICES.txt" "$work/"
chmod +x "$work/marfa" "$work/marfa-server"
tar -czf "$archive" -C "$work" marfa marfa-server NOTICES.txt
echo "$(basename "$archive") packed"
