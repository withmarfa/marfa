#!/usr/bin/env bash
# Builds the Swift package MarfaCore (an XCFramework plus generated Swift)
# into ./MarfaCore with cargo-swift, macOS arm64 only.
set -euo pipefail
cd "$(dirname "$0")"

if ! cargo swift --version >/dev/null 2>&1; then
  cargo install cargo-swift --locked
fi

# x86_64 is excluded because only the host target is installed; the slice is
# arm64 macOS until the release job builds the rest.
cargo swift package \
  --platforms macos \
  --name MarfaCore \
  --release \
  --exclude-arch x86_64-apple-darwin \
  --swift-tools-version 5.9 \
  --accept-all \
  --silent
