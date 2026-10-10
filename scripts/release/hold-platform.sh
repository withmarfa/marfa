#!/usr/bin/env bash
# Refuse an npm tarball whose manifest does not limit the install to the one
# platform its binary is built for. Without `os` and `cpu` the package
# installs anywhere and fails at the first `require`.
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
