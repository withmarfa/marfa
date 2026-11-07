#!/bin/bash
# Builds Leptonica and Tesseract as static libraries for a target, with no image
# codecs, no OpenMP, no training tools and no network, and installs libleptonica.a,
# libtesseract.a and their headers into the target's prefix.
#
#   MARFA_NATIVE_ROOT=<folder> native/tesseract.sh <target>
#
# Needs cmake and ninja on PATH, and a C++17 compiler: Apple's clang on a Mac, the
# pinned musl cross compiler on Linux.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need cmake ninja tar

# Where a build that finds an older macOS fails to link a newer one.
MACOS_DEPLOYMENT_TARGET=${MARFA_MACOS_DEPLOYMENT_TARGET:-13.0}

common=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
)
case "$CMAKE_SYSTEM" in
  Darwin)
    need xcrun
    common+=(
      -DCMAKE_OSX_ARCHITECTURES="$CMAKE_PROCESSOR"
      -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
      -DCMAKE_OSX_SYSROOT="$(xcrun --sdk macosx --show-sdk-path)"
    )
    ;;
  Linux)
    toolchain="$WORK/$MUSL_TOOLCHAIN"
    [ -x "$toolchain/bin/${MUSL_PREFIX}g++" ] || musl_into "$MUSL_TOOLCHAIN" "$toolchain"
    common+=(
      -DCMAKE_SYSTEM_NAME=Linux
      -DCMAKE_SYSTEM_PROCESSOR="$CMAKE_PROCESSOR"
      -DCMAKE_C_COMPILER="$toolchain/bin/${MUSL_PREFIX}gcc"
      -DCMAKE_CXX_COMPILER="$toolchain/bin/${MUSL_PREFIX}g++"
    )
    ;;
esac

SRC="$WORK/src"
STAGE="$WORK/stage"
rm -rf "$SRC" "$STAGE"
archive_into leptonica "$SRC/leptonica"
archive_into tesseract "$SRC/tesseract"

cmake -S "$SRC/leptonica" -B "$SRC/leptonica/build" "${common[@]}" \
  -DCMAKE_INSTALL_PREFIX="$STAGE" \
  -DSW_BUILD=OFF -DBUILD_PROG=OFF \
  -DENABLE_ZLIB=OFF -DENABLE_PNG=OFF -DENABLE_GIF=OFF -DENABLE_JPEG=OFF \
  -DENABLE_TIFF=OFF -DENABLE_WEBP=OFF -DENABLE_OPENJPEG=OFF
cmake --build "$SRC/leptonica/build"
cmake --install "$SRC/leptonica/build"

cmake -S "$SRC/tesseract" -B "$SRC/tesseract/build" "${common[@]}" \
  -DCMAKE_INSTALL_PREFIX="$STAGE" \
  -DCMAKE_PREFIX_PATH="$STAGE" \
  -DLeptonica_DIR="$STAGE/lib/cmake/leptonica" \
  -DOPENMP_BUILD=OFF -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF \
  -DGRAPHICS_DISABLED=ON -DDISABLED_LEGACY_ENGINE=ON -DENABLE_NATIVE=OFF \
  -DENABLE_LTO=OFF -DENABLE_CCACHE=OFF -DENABLE_PRECOMPILED_HEADERS=OFF \
  -DDISABLE_TIFF=ON -DDISABLE_ARCHIVE=ON -DDISABLE_CURL=ON -DINSTALL_CONFIGS=OFF \
  -DUSE_SYSTEM_ICU=OFF
cmake --build "$SRC/tesseract/build"
cmake --install "$SRC/tesseract/build"

cp "$STAGE/lib/libleptonica.a" "$STAGE/lib/libtesseract.a" "$PREFIX/lib/"
rm -rf "$PREFIX/include/leptonica" "$PREFIX/include/tesseract"
cp -R "$STAGE/include/leptonica" "$STAGE/include/tesseract" "$PREFIX/include/"
mkdir -p "$PREFIX/licenses"
cp "$SRC/leptonica/leptonica-license.txt" "$PREFIX/licenses/leptonica.txt"
cp "$SRC/tesseract/LICENSE" "$PREFIX/licenses/tesseract.txt"
echo "tesseract: installed into $PREFIX"
