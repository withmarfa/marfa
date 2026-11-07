#!/bin/bash
# Installs the Rust toolchain the manifest pins into the folder given, from the
# standalone installers, each verified by its hash.
#
#   native/linux/install-rust.sh <folder>
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

[ -n "${1:-}" ] || die "usage: install-rust.sh <folder>"
dest=$1
DOWNLOADS=$(mktemp -d)
need curl tar

while read -r kind name _; do
  [ "$kind" = tool ] || continue
  case "$name" in rust-*) ;; *) continue ;; esac
  work=$(mktemp -d)
  tool_into "$name" "$work"
  # Installers hold one install.sh and a component folder per piece.
  (cd "$work" && ./install.sh --prefix="$dest" --disable-ldconfig --without=rust-docs >/dev/null) \
    || die "could not install $name"
  rm -rf "$work"
done <"$MANIFEST"
rm -rf "$DOWNLOADS"
"$dest/bin/rustc" --version
"$dest/bin/rustc" --print target-list >/dev/null
for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  [ -d "$dest/lib/rustlib/$target/lib" ] || die "no standard library for $target"
done
