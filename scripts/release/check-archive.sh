#!/usr/bin/env bash
# Unpacks a release archive and runs its programs, so it needs the archive's architecture.
#
#   check-archive.sh <archive> <version> [--boot]
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
