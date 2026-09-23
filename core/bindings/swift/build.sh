#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! cargo swift --version >/dev/null 2>&1; then
  cargo install cargo-swift --locked
fi

# The oldest systems an app embedding the core supports, in both places that
# need them. Without the deployment targets the C the core links (SQLite,
# the TLS stack) is compiled for whichever system built it; without the
# platforms the generated package claims systems its objects do not run on.
macos=15
ios=18
export MACOSX_DEPLOYMENT_TARGET="${macos}.0"
export IPHONEOS_DEPLOYMENT_TARGET="${ios}.0"

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

# cargo-swift names each platform's version by an enum case, and the tools
# version the glue compiles under (5.9, since the glue is not Swift 6 clean)
# has none for these. A version string says the same to every tools version.
manifest=MarfaCore/Package.swift
sed -i '' -E \
  -e "s/\.macOS\(\.v[0-9_]+\)/.macOS(\"${macos}.0\")/" \
  -e "s/\.iOS\(\.v[0-9_]+\)/.iOS(\"${ios}.0\")/" \
  "${manifest}"
grep -q "\.macOS(\"${macos}.0\"), \.iOS(\"${ios}.0\")" "${manifest}" || {
  echo "build.sh: ${manifest} does not declare macOS ${macos} and iOS ${ios}" >&2
  exit 1
}
