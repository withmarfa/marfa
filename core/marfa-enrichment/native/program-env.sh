#!/bin/bash
# The toolchain a program of this crate's native build is built with: the pinned Rust, the
# prefix, and on Linux the one musl compiler PDFium and Tesseract were built with. Sourced
# by program.sh and server.sh after they have chosen the target and the folder.
CORE=$(cd "$NATIVE_DIR/../.." && pwd)

want=$(manifest_line toolchain rust | awk '{ print $3 }')
have=$(rustc --version | awk '{ print $2 }')
[ "$have" = "$want" ] || [ -n "${MARFA_ALLOW_OTHER_RUST:-}" ] \
  || die "the manifest pins Rust $want and rustc is $have (MARFA_ALLOW_OTHER_RUST=1 builds anyway)"

[ -f "$PREFIX/lib/libpdfium.a" ] || die "no prefix at $PREFIX; run native/build.sh $TARGET first"

# Cargo's output, its cache of downloaded crates, and nothing from the caller's
# configuration: not the compiler wrapper or the shared build folder a developer sets.
TARGET_DIR=${MARFA_CARGO_TARGET_DIR:-$ROOT/cargo-target}
export CARGO_TARGET_DIR="$TARGET_DIR/$TARGET"
export CARGO_BUILD_BUILD_DIR="$CARGO_TARGET_DIR"
export CARGO_BUILD_RUSTC_WRAPPER=
export RUSTC_WRAPPER=
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_RELEASE_STRIP=symbols
export MARFA_NATIVE_PREFIX="$PREFIX"

# Paths in the program name the code, not the builder's folders.
remap="--remap-path-prefix=$CORE=/marfa/core --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
flags="$remap"

case "$TARGET" in
  aarch64-apple-darwin)
    # PDFium's objects are built for 13.0. The Rust code, the shim and the linker
    # must not claim an older macOS than the oldest one the library supports.
    export MACOSX_DEPLOYMENT_TARGET=${MARFA_MACOS_DEPLOYMENT_TARGET:-13.0}
    ;;
  *-unknown-linux-musl)
    # One compiler for everything: the one PDFium and Tesseract were built with, and
    # its libstdc++ and musl, so the program holds one C++ library.
    kept_tool "$MUSL_TOOLCHAIN"
    toolchain=$KEPT_TOOL
    underscored=${TARGET//-/_}
    upper=$(echo "$underscored" | tr '[:lower:]' '[:upper:]')
    export "CARGO_TARGET_${upper}_LINKER=$toolchain/bin/${MUSL_PREFIX}gcc"
    export "CC_${underscored}=$toolchain/bin/${MUSL_PREFIX}gcc"
    export "CXX_${underscored}=$toolchain/bin/${MUSL_PREFIX}g++"
    export "AR_${underscored}=$toolchain/bin/${MUSL_PREFIX}ar"
    # The toolchain's own C library and start files, which its libstdc++ was built
    # against, in place of the ones rustc carries.
    flags="$flags -C link-self-contained=no"
    need file readelf
    ;;
esac
export RUSTFLAGS="$flags"
