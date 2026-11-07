#!/bin/bash
# Builds PDFium as one static library for a target with bblanchon's build.sh,
# keeps the finished library in an archive, and installs libpdfium.a and its headers
# and licenses into the target's prefix.
#
#   MARFA_NATIVE_ROOT=<folder> native/pdfium.sh <target>
#
# A build needs about 6 GB for the checkout, which is deleted once the archive is
# saved (set MARFA_KEEP_WORK=1 to keep it). The archive is named for the recipe: the
# pins and patches that decide what the library holds. A later run with the same
# recipe installs from the archive and builds nothing, and a run with another recipe
# builds again.
#
# Needs git, curl, python3, patch and tar. For Linux it also needs a g++ for the
# tools PDFium builds for itself, and pkg-config, and it must run on x86_64 Linux:
# the cross compilers and Google's build tools are x86_64 programs. native/linux/
# makes the image that has all of that.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need git curl python3 patch tar

BRANCH=$(manifest_line git pdfium | awk '{ print $4 }')
COMMIT=$(manifest_line git pdfium | awk '{ print $5 }')

recipe_items=(
  "line:git:pdfium" "line:git:depot_tools" "line:archive:pdfium-binaries"
  "file:$NATIVE_DIR/pdfium.sh" "file:$NATIVE_DIR/lib.sh"
)
for patch in "$NATIVE_DIR"/patches/pdfium-*.patch; do
  [ -e "$patch" ] && recipe_items+=("file:$patch")
done
if [ -n "$MUSL_TOOLCHAIN" ]; then
  recipe_items+=("line:tool:$MUSL_TOOLCHAIN" "line:image:build" "line:apt-snapshot:ubuntu")
fi
RECIPE=$(recipe_hash "${recipe_items[@]}")
ARCHIVE="$ARCHIVES/pdfium-$TARGET-$RECIPE.tgz"

install_from_archive() {
  rm -rf "$PREFIX/include/pdfium" "$PREFIX/licenses/pdfium"
  mkdir -p "$PREFIX/lib"
  tar -xzf "$ARCHIVE" -C "$PREFIX"
  [ -f "$PREFIX/lib/libpdfium.a" ] || die "$ARCHIVE holds no lib/libpdfium.a"
  echo "pdfium: installed $(wc -c <"$PREFIX/lib/libpdfium.a") bytes from $ARCHIVE"
}

if [ -f "$ARCHIVE" ] && [ -f "$ARCHIVE.sha256" ] \
  && [ "$(sha256_of "$ARCHIVE")" = "$(cut -d' ' -f1 <"$ARCHIVE.sha256")" ]; then
  install_from_archive
  exit 0
fi
rm -f "$ARCHIVE" "$ARCHIVE.sha256"

# The branch moves only if PDFium cherry-picks onto it. Stopping here costs
# nothing; stopping after the build would cost the build.
head=$(git ls-remote "$(manifest_line git pdfium | awk '{ print $3 }')" "refs/heads/$BRANCH" | cut -f1)
[ "$head" = "$COMMIT" ] || die "PDFium $BRANCH is at ${head:-nothing}, and the manifest pins $COMMIT"

BUILD="$WORK/pdfium-binaries"
DEPOT_TOOLS="$WORK_ROOT/depot_tools"
checkout depot_tools "$DEPOT_TOOLS"
bootstrap_depot_tools "$DEPOT_TOOLS"

# A run that stopped part way keeps its checkout: the scripts are unpacked afresh
# only when the archive pinned is not the one already there.
pin=$(manifest_line archive pdfium-binaries | awk '{ print $5 }')
if [ "$(cat "$BUILD/.pin" 2>/dev/null)" != "$pin-$RECIPE" ]; then
  archive_into pdfium-binaries "$BUILD"
  # The static PDFium is built without V8 and XFA (build.sh's default), and with
  # the patches build.sh applies for a static library. Marfa's own changes to its
  # steps are patches in native/patches/, applied to the verified archive before
  # anything runs.
  for patch in "$NATIVE_DIR"/patches/pdfium-*.patch; do
    [ -e "$patch" ] || continue
    patch -p1 -d "$BUILD" -i "$patch" >/dev/null || die "could not apply $patch"
  done
  echo "$pin-$RECIPE" >"$BUILD/.pin"
fi

cd "$BUILD"
# depot_tools would update itself past the commit pinned in the manifest.
export DEPOT_TOOLS_UPDATE=0
export PDFium_TARGET_OS=$PDFIUM_OS PDFium_TARGET_CPU=$PDFIUM_CPU PDFium_TARGET_ENVIRONMENT=$PDFIUM_ENV

# build.sh's step 0 writes the environment file its later steps read, and step 1
# installs what a CI runner lacks: `sudo xcode-select` on a Mac, apt packages on
# Linux. Marfa's builders already have those (a Mac builds with the Xcode it has,
# the Linux image has the packages), so the build starts at step 2.
bash steps/00-environment.sh
{
  echo "$DEPOT_TOOLS"
  [ -n "$MUSL_TOOLCHAIN" ] && echo "$BUILD/$MUSL_TOOLCHAIN/bin"
} >.path
if [ "$PDFIUM_OS" = mac ]; then
  need xcrun
else
  need g++ pkg-config cmake
  # build.sh downloads the toolchain unless the folder is already there.
  tool_into "$MUSL_TOOLCHAIN" "$BUILD/$MUSL_TOOLCHAIN"
fi

args=(-s -b "$BRANCH")
if [ -n "$PDFIUM_ENV" ]; then
  platform=("$PDFIUM_OS" "$PDFIUM_CPU" "$PDFIUM_ENV")
else
  platform=("$PDFIUM_OS" "$PDFIUM_CPU")
fi

# depot_tools downloads its tools in parallel and locks one folder for them. Under
# emulation a hook can wait past the lock's 30 seconds, and the run stops with
# `LockError: Error locking .../gsutil_5.35`. Nothing is wrong with the build; the
# checkout is made again from step 2 (which resets what it holds) up to four times.
log="$WORK/pdfium-build.log"
: >"$log"
step=2
for attempt in 1 2 3 4; do
  attempt_log="$WORK/pdfium-attempt-$attempt.log"
  if ./build.sh "${args[@]}" -g "$step" "${platform[@]}" 2>&1 | tee "$attempt_log" >>"$log"; [ "${PIPESTATUS[0]}" -eq 0 ]; then
    break
  fi
  if [ "$attempt" -lt 4 ] && grep -q 'LockError' "$attempt_log"; then
    echo "pdfium: depot_tools' download lock timed out (attempt $attempt); trying again" >&2
    sleep 20
    step=2
    continue
  fi
  tail -n 40 "$attempt_log" >&2
  die "build.sh failed (attempt $attempt); the full log is $log"
done
tail -n 5 "$log"

[ -f staging/lib/libpdfium.a ] || die "build.sh did not make staging/lib/libpdfium.a"
STAGE_OUT="$WORK/pdfium-out"
rm -rf "$STAGE_OUT"
mkdir -p "$STAGE_OUT/lib" "$STAGE_OUT/licenses"
cp staging/lib/libpdfium.a "$STAGE_OUT/lib/libpdfium.a"
cp -R staging/include "$STAGE_OUT/include-pdfium"
mkdir -p "$STAGE_OUT/include"
mv "$STAGE_OUT/include-pdfium" "$STAGE_OUT/include/pdfium"
cp -R staging/licenses "$STAGE_OUT/licenses/pdfium"
cp staging/args.gn "$STAGE_OUT/pdfium-args.gn"
echo "$COMMIT" >"$STAGE_OUT/pdfium-commit"
tar -czf "$ARCHIVE.part" -C "$STAGE_OUT" .
mv "$ARCHIVE.part" "$ARCHIVE"
echo "$(sha256_of "$ARCHIVE")  $(basename "$ARCHIVE")" >"$ARCHIVE.sha256"
echo "pdfium: saved $ARCHIVE"
install_from_archive

# The archive keeps what the checkout took 6 GB to make.
cd "$ROOT"
rm -rf "$STAGE_OUT"
if [ -z "${MARFA_KEEP_WORK:-}" ]; then
  rm -rf "$BUILD"
  echo "pdfium: removed the checkout $BUILD"
fi
