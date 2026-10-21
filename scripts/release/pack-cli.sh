#!/usr/bin/env bash
# Pack the `marfa` binary into a release archive, then unpack that archive
# and run what came out: the archive is only as good as the binary a person
# extracts from it. Refuses an archive whose binary does not report
# `marfa <version>`.
#
#   pack-cli.sh <binary> <archive> <version> [command...]
#
# The optional command runs the extracted binary, for one built for another
# architecture than the runner's, such as `arch -x86_64` for an Intel Mac
# binary under Rosetta.
set -euo pipefail

binary="$1"
archive="$2"
version="$3"
shift 3

if [ ! -s "$binary" ]; then
  echo "::error::$binary is not a non-empty file."
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/pack" "$work/unpack"
cp "$binary" "$work/pack/marfa"
chmod +x "$work/pack/marfa"
tar -czf "$archive" -C "$work/pack" marfa

if [ "$(tar -tzf "$archive")" != "marfa" ]; then
  echo "::error::$(basename "$archive") holds more than the one file marfa:"
  tar -tzf "$archive"
  exit 1
fi
tar -xzf "$archive" -C "$work/unpack"
reported=$("$@" "$work/unpack/marfa" --version)
if [ "$reported" != "marfa $version" ]; then
  echo "::error::The binary in $(basename "$archive") reports '$reported', not 'marfa $version'."
  exit 1
fi
echo "$(basename "$archive"): $reported"
