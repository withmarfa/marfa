#!/bin/bash
# Builds the programs a release ships for one target, `marfa-server` and `marfa`, from
# the same toolchain, environment and native prefix as the file reader, and checks them.
#
#   MARFA_NATIVE_ROOT=<folder> scripts/release/build-programs.sh <target>
#
#   <target>   aarch64-apple-darwin, aarch64-unknown-linux-musl or x86_64-unknown-linux-musl
#
# It first runs core/marfa-enrichment/native/release.sh for the target, which makes the
# prefix and the file reader and checks it (see that script for what the runner needs).
# Then it builds the two programs with `--release --locked`, stripped: on the Mac on the
# host, on Linux inside the build image that release.sh uses. It checks each as the file
# reader is checked, runs it where it can run here and requires `--version` to print its
# name and the version of core/Cargo.toml.
#
# The result is in $MARFA_NATIVE_ROOT/out/<target>/: marfa, marfa-server and NOTICES.txt,
# the licences of every crate and native library the two hold. That NOTICES.txt takes the
# place of the file reader's, which is not shipped. The reader and its other files stay
# where release.sh puts them.
#
# MARFA_RELEASE_PREFIX and MARFA_KEEP_WORK are the ones release.sh reads.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NATIVE="$REPO/core/marfa-enrichment/native"
# shellcheck source=../../core/marfa-enrichment/native/lib.sh
source "$NATIVE/lib.sh"

# `--inside` is the second half of a Linux build, started in the build image.
inside=
if [ "${1:-}" = --inside ]; then
  inside=1
  shift
fi
[ $# -eq 1 ] || die "usage: build-programs.sh <target>   ($SUPPORTED_TARGETS)"
select_target "$1"
select_root
CORE="$REPO/core"
OUT="$ROOT/out/$TARGET"
PROGRAMS=(marfa-server marfa)

version=$(awk '/^\[/ { own = ($0 == "[workspace.package]") }
               own && /^version = / { gsub(/"/, "", $3); print $3; exit }' "$CORE/Cargo.toml")
[ -n "$version" ] || die "$CORE/Cargo.toml names no workspace version"

# build_and_check: the programs, their checks and their licences, on a Mac or in the image.
build_and_check() {
  need cargo rustc python3
  mkdir -p "$OUT"
  rm -f "$OUT/marfa" "$OUT/marfa-server"
  cargo_environment
  case "$TARGET" in
    *-unknown-linux-musl)
      # Without the bundled libunwind (link-self-contained=no), the standard library's
      # `-lunwind` finds nothing; the script sends it to the toolchain's one unwinder,
      # as the file reader's build script does for itself.
      mkdir -p "$CARGO_TARGET_DIR/unwind"
      echo 'INPUT(-lgcc_eh)' >"$CARGO_TARGET_DIR/unwind/libunwind.a"
      export RUSTFLAGS="$RUSTFLAGS -L $CARGO_TARGET_DIR/unwind"
      ;;
  esac

  # The server's native feature turns file reading on; until it has one, nothing differs.
  local native=()
  if (cd "$CORE" && cargo metadata --no-deps --format-version 1 --locked) | python3 -I -c '
import json, sys
server = next(p for p in json.load(sys.stdin)["packages"] if p["name"] == "marfa-server")
sys.exit(0 if "native" in server["features"] else 1)'; then
    native=(--features native)
  fi

  local program package features
  for program in "${PROGRAMS[@]}"; do
    package=marfa-server
    features=()
    if [ "$program" = marfa ]; then
      package=marfa-cli
    else
      features=(${native[@]+"${native[@]}"})
    fi
    echo "programs: build $program"
    (cd "$CORE" && cargo build --release --locked --target "$TARGET" -p "$package" --bin "$program" \
      ${features[@]+"${features[@]}"})
    cp "$CARGO_TARGET_DIR/$TARGET/release/$program" "$OUT/$program"
    check_program "$OUT/$program"
  done

  echo "programs: gather the licences"
  "$NATIVE/licenses.sh" "$TARGET" --out "$OUT/NOTICES.txt" marfa-server marfa-cli
}

# say_version <program> <command...>: runs the program's `--version` and requires its name
# and the version of core/Cargo.toml. A program that cannot start here for want of its
# architecture is said so and skipped; one that starts and answers wrongly stops the build.
say_version() {
  local program=$1
  shift
  local said
  said=$("$@" --version 2>&1) || true
  case "$said" in
    *"exec format error"* | *"Exec format error"* | *"cannot execute binary"*)
      echo "programs: $program cannot run on this machine; its version is not checked here"
      return 0
      ;;
  esac
  [ "$said" = "$program $version" ] \
    || die "$program --version printed '$said', not '$program $version'"
  echo "programs: $said"
}

case "$TARGET" in
  aarch64-apple-darwin)
    [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die "$TARGET builds on a Mac with Apple silicon"
    echo "programs: the file reader and the prefix (native/release.sh)"
    # PDFium's build steps write to the runner's files when they see these, and lose
    # depot_tools from PATH.
    env -u GITHUB_ENV -u GITHUB_PATH "$NATIVE/release.sh" "$TARGET"
    build_and_check
    for program in "${PROGRAMS[@]}"; do
      say_version "$program" env -i "$OUT/$program"
    done
    ;;
  *)
    if [ -n "$inside" ]; then
      build_and_check
      exit 0
    fi
    need docker
    echo "programs: the file reader and the prefix (native/release.sh)"
    "$NATIVE/release.sh" "$TARGET"
    prefix=${MARFA_RELEASE_PREFIX:-marfa-release}
    image="$prefix-build"
    volume="$prefix-work"
    make_build_image "$image"
    docker volume create "$volume" >/dev/null
    echo "programs: build, check and list the licences, in the image"
    docker run --rm --platform linux/amd64 \
      -v "$ROOT:/native-root" -v "$volume:/work" -v "$REPO:/repo:ro" \
      -e MARFA_NATIVE_ROOT=/native-root -e MARFA_NATIVE_WORK=/work -e CARGO_HOME=/work/cargo-home \
      -e MARFA_KEEP_WORK="${MARFA_KEEP_WORK:-}" \
      "$image" /repo/scripts/release/build-programs.sh --inside "$TARGET"
    # The image runs as root, so what it wrote is root's.
    docker run --rm --platform linux/amd64 -v "$ROOT:/native-root" "$image" \
      chown -R "$(id -u):$(id -g)" /native-root

    case "$TARGET" in aarch64-*) arch=aarch64 platform=linux/arm64 ;; *) arch=x86_64 platform=linux/amd64 ;; esac
    if [ "$(uname -s)-$(uname -m)" = "Linux-$arch" ]; then
      for program in "${PROGRAMS[@]}"; do
        say_version "$program" env -i "$OUT/$program"
      done
    else
      # Another architecture: an image of nothing but the program, run under the engine.
      smoke="$ROOT/work/programs-$TARGET"
      rm -rf "$smoke"
      mkdir -p "$smoke"
      cp "$OUT/marfa" "$OUT/marfa-server" "$smoke/"
      printf 'FROM scratch\nCOPY marfa marfa-server /\n' >"$smoke/Dockerfile"
      docker build --quiet --platform "$platform" -t "$prefix-programs" "$smoke" >/dev/null \
        || die "could not build the image that runs the programs"
      for program in "${PROGRAMS[@]}"; do
        say_version "$program" docker run --rm --platform "$platform" "$prefix-programs" "/$program"
      done
      docker rmi "$prefix-programs" >/dev/null 2>&1 || true
      rm -rf "$smoke"
    fi
    ;;
esac

for program in "${PROGRAMS[@]}"; do
  echo "programs: $(wc -c <"$OUT/$program") bytes $OUT/$program"
done
echo "programs: licences  $OUT/NOTICES.txt"
