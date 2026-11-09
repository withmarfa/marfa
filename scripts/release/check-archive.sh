#!/usr/bin/env bash
# Unpack a release archive and run what came out: the archive is only as good
# as the programs a person extracts from it. Refuses an archive that holds
# anything but `marfa`, `marfa-server` and `NOTICES.txt`, or whose programs do
# not report the version. With --boot, starts `marfa-server` as well and waits
# for it to answer (`boot-server.sh`).
#
#   check-archive.sh <archive> <version> [--boot]
#
# It runs the programs, so it runs on the architecture the archive is for.
set -euo pipefail

archive="$1"
version="$2"
boot="${3:-}"

listed=$(tar -tzf "$archive" | LC_ALL=C sort)
if [ "$listed" != "$(printf '%s\n' NOTICES.txt marfa marfa-server)" ]; then
  echo "::error::$(basename "$archive") does not hold exactly marfa, marfa-server and NOTICES.txt:"
  echo "$listed"
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
for program in marfa marfa-server; do
  reported=$("$work/$program" --version)
  if [ "$reported" != "$program $version" ]; then
    echo "::error::$program in $(basename "$archive") reports '$reported', not '$program $version'."
    exit 1
  fi
  echo "$(basename "$archive"): $reported"
done

if [ "$boot" = "--boot" ]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/boot-server.sh" "$work/marfa-server"
elif [ -n "$boot" ]; then
  echo "check-archive: unknown option $boot" >&2
  exit 2
fi
