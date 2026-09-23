#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! cargo swift --version >/dev/null 2>&1; then
  cargo install cargo-swift --locked
fi

# The oldest systems an app embedding the core supports. Without these the C
# the core links (SQLite, the TLS stack) is compiled for whichever system
# built it, and an app targeting an older one links objects newer than it.
export MACOSX_DEPLOYMENT_TARGET=15.0
export IPHONEOS_DEPLOYMENT_TARGET=18.0

# arm64 only, for the Mac, the phone and the simulator: the x86_64 targets
# are not installed on the machines that build this.
cargo swift package \
  --platforms macos ios \
  --name MarfaCore \
  --release \
  --exclude-arch x86_64-apple-darwin \
  --exclude-arch x86_64-apple-ios \
  --swift-tools-version 5.9 \
  --accept-all \
  --silent
