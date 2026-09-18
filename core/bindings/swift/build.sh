#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! cargo swift --version >/dev/null 2>&1; then
  cargo install cargo-swift --locked
fi

# x86_64 is excluded because only the host target is installed.
cargo swift package \
  --platforms macos \
  --name MarfaCore \
  --release \
  --exclude-arch x86_64-apple-darwin \
  --swift-tools-version 5.9 \
  --accept-all \
  --silent
