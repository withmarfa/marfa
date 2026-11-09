#!/usr/bin/env bash
# Refuses an npm tarball whose manifest lacks `os` and `cpu`, which would install anywhere.
#
#   hold-platform.sh <tarball> <os> <cpu>
set -euo pipefail

tarball="$1"
os="$2"
cpu="$3"
declared=$(
  tar -xzOf "$tarball" package/package.json | node -e '
    const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify([manifest.os, manifest.cpu]));
  '
)
wanted=$(printf '[["%s"],["%s"]]' "$os" "$cpu")
if [ "$declared" != "$wanted" ]; then
  echo "::error::$(basename "$tarball") declares [os, cpu] as $declared, not $wanted."
  exit 1
fi
echo "$(basename "$tarball") installs only on $os $cpu"
