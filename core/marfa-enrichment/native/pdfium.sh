#!/bin/bash
# Builds PDFium as one static library for a target with bblanchon's build.sh,
# and installs libpdfium.a and its headers into the target's prefix.
#
#   MARFA_NATIVE_ROOT=<folder> native/pdfium.sh <target>
#
# Needs about 6 GB for the checkout and git, python3 and curl. On Linux,
# bblanchon's steps also run apt-get with sudo, as its own CI does.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need git curl python3

BRANCH=$(manifest_line git pdfium | awk '{ print $4 }')
COMMIT=$(manifest_line git pdfium | awk '{ print $5 }')

# The branch moves only if PDFium cherry-picks onto it. Stopping here costs
# nothing; stopping after the build would cost the build.
head=$(git ls-remote "$(manifest_line git pdfium | awk '{ print $3 }')" "refs/heads/$BRANCH" | cut -f1)
[ "$head" = "$COMMIT" ] || die "PDFium $BRANCH is at ${head:-nothing}, and the manifest pins $COMMIT"

BUILD="$WORK/pdfium-binaries"
checkout depot_tools "$DOWNLOADS/depot_tools"
bootstrap_depot_tools "$DOWNLOADS/depot_tools"

# A run that stopped part way keeps its 6 GB checkout: the scripts are unpacked
# afresh only when the archive pinned is not the one already there.
pin=$(manifest_line archive pdfium-binaries | awk '{ print $5 }')
if [ "$(cat "$BUILD/.pin" 2>/dev/null)" != "$pin" ]; then
  archive_into pdfium-binaries "$BUILD"
  # The static PDFium is built without V8 and XFA (build.sh's default), and with
  # the patches build.sh applies for a static library. Marfa's own change to its
  # arguments, if a target needs one, is a patch in native/patches/ applied to the
  # verified archive before anything runs.
  for patch in "$NATIVE_DIR"/patches/pdfium-*.patch; do
    [ -e "$patch" ] || continue
    patch -p1 -d "$BUILD" -i "$patch" >/dev/null || die "could not apply $patch"
  done
  echo "$pin" >"$BUILD/.pin"
fi

if [ -n "$MUSL_TOOLCHAIN" ]; then
  # build.sh downloads the toolchain unless the folder is already there.
  musl_into "$MUSL_TOOLCHAIN" "$BUILD/$MUSL_TOOLCHAIN"
fi

cd "$BUILD"
# depot_tools would update itself past the commit pinned in the manifest.
export DEPOT_TOOLS_UPDATE=0
export PATH="$DOWNLOADS/depot_tools:$PATH"
export PDFium_TARGET_OS=$PDFIUM_OS PDFium_TARGET_CPU=$PDFIUM_CPU PDFium_TARGET_ENVIRONMENT=$PDFIUM_ENV

if [ "$PDFIUM_OS" = mac ]; then
  # Step 1 of build.sh runs `sudo xcode-select -s` on a CI runner. A Mac that
  # builds locally uses the Xcode it already has, so the build starts at step 2.
  need xcrun
  bash steps/00-environment.sh
  echo "$DOWNLOADS/depot_tools" >.path
  start=2
else
  start=0
fi

args=(-s -b "$BRANCH" -g "$start")
if [ -n "$PDFIUM_ENV" ]; then
  args+=("$PDFIUM_OS" "$PDFIUM_CPU" "$PDFIUM_ENV")
else
  args+=("$PDFIUM_OS" "$PDFIUM_CPU")
fi
./build.sh "${args[@]}"

[ -f staging/lib/libpdfium.a ] || die "build.sh did not make staging/lib/libpdfium.a"
cp staging/lib/libpdfium.a "$PREFIX/lib/libpdfium.a"
rm -rf "$PREFIX/include/pdfium"
cp -R staging/include "$PREFIX/include/pdfium"
mkdir -p "$PREFIX/licenses/pdfium"
cp -R staging/licenses/. "$PREFIX/licenses/pdfium/"
cp staging/args.gn "$PREFIX/pdfium-args.gn"
echo "$COMMIT" >"$PREFIX/pdfium-commit"
echo "pdfium: installed $(wc -c <"$PREFIX/lib/libpdfium.a") bytes into $PREFIX/lib"
