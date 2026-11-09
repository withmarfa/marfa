#!/bin/bash
# One command from an empty folder to a checked program for one target: fetches and
# verifies every source, builds PDFium, Leptonica, Tesseract and the program, links
# it, checks what it made, gathers the licences, and reads a file with the finished
# program and nothing else installed.
#
#   MARFA_NATIVE_ROOT=<folder> native/release.sh <target> [--full] [--needs]
#
#   <target>   aarch64-apple-darwin, aarch64-unknown-linux-musl or x86_64-unknown-linux-musl
#   --full     also run the whole matrix of native/verify.sh (every format, OCR in six
#              languages, damaged files, injected faults, the memory limit)
#   --server   build the libraries and the server with them linked in
#              (out/<target>/marfa-server, native/server.sh), and nothing else
#   --needs    print what the runner must have, and stop
#
# The result is in $MARFA_NATIVE_ROOT/out/<target>/: marfa-enrichment-read (what ships),
# NOTICES.txt (the licences that ship with it), SHA256SUMS, and the proof and fuzz programs
# that never ship.
#
# The folder holds downloads (shared by the targets), the finished PDFium of each
# recipe (archives/), a prefix for each target, and the work. A second run builds only
# what changed.
#
# Optional settings:
#   MARFA_NATIVE_WORK       where the PDFium checkout goes on a Mac (default: inside the folder).
#   MARFA_RELEASE_PREFIX    the name for the container image and volume (default marfa-release).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

needs() {
  cat <<'EOF'
Every target:
  - the network (GitHub, googlesource.com, static.rust-lang.org, raw.githubusercontent.com, and
    musl.cc or, when it is out of reach, owncast-infra.nyc3.cdn.digitaloceanspaces.com or web.archive.org)
  - 40 GB of free disk space for the first build of a target (a PDFium checkout is 6 GB;
    it is deleted once the library is saved), then about 1.5 GB per target
  - bash, curl, git, python3, tar, patch, and a sha256 tool (sha256sum or shasum)

aarch64-apple-darwin, on a Mac with Apple silicon:
  - Xcode or the Command Line Tools (clang, xcrun, otool, vtool, codesign)
  - Rust 1.98.1 (rustup toolchain install 1.98.1; the manifest pins the version)
  - cmake and ninja on PATH
  - the target's PDFium is built on the Mac itself, with Chromium's own clang

aarch64-unknown-linux-musl and x86_64-unknown-linux-musl, on any machine with Docker:
  - Docker, which builds the pinned image (Ubuntu 24.04 by digest, packages from one
    day's archive snapshot, Rust from the pinned installers). The image is linux/amd64:
    Google's build tools and the musl.cc cross compilers are x86_64 programs. On an
    Apple silicon Mac it runs emulated, and the first PDFium build takes about 30 minutes
    where a native x86_64 machine takes a fraction of that.
  - nothing else: no compiler, Rust, cmake or Python on the host for the build
  - to check the finished program: Docker runs it in a `FROM scratch` image. On a host of
    the other architecture that run is emulated.
EOF
}

select_target "${1:-}"
shift
full=
server=
while [ $# -gt 0 ]; do
  case "$1" in
    --full) full=1; shift ;;
    --server) server=1; shift ;;
    --needs) needs; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
select_root
[ -n "${MARFA_NATIVE_ROOT:-}" ] || die "set MARFA_NATIVE_ROOT"

CRATE=$(cd "$NATIVE_DIR/.." && pwd)
CORE=$(cd "$CRATE/.." && pwd)
REPOSITORY=$(cd "$CORE/.." && pwd)
OUT="$ROOT/out/$TARGET"
started=$SECONDS
stage_start=$SECONDS
stage() {
  local now=$SECONDS
  [ "$now" -gt "$stage_start" ] && echo "release: ... $((now - stage_start)) seconds"
  stage_start=$now
  echo "release: $*"
}

case "$TARGET" in
  aarch64-apple-darwin)
    [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die "$TARGET builds on a Mac with Apple silicon"
    need git curl python3 tar patch cmake ninja cargo rustc xcrun otool vtool codesign
    stage "build the libraries (native/build.sh)"
    "$NATIVE_DIR/build.sh" "$TARGET"
    if [ -n "$server" ]; then
      stage "build the server (native/server.sh)"
      "$NATIVE_DIR/server.sh" "$TARGET"
      exit 0
    fi
    stage "build, link and check the programs (native/program.sh)"
    "$NATIVE_DIR/program.sh" "$TARGET"
    stage "gather the licences (native/licenses.sh)"
    "$NATIVE_DIR/licenses.sh" "$TARGET"
    ;;
  *)
    need docker
    prefix=${MARFA_RELEASE_PREFIX:-marfa-release}
    image="$prefix-build"
    volume="$prefix-work"
    stage "make the build image $image"
    make_build_image "$image"
    docker volume create "$volume" >/dev/null
    # The checkout and the Cargo caches live on a volume of the engine's own file
    # system, which tells `A` from `a` and holds many small files; the folder the
    # caller names is a mount from the host and does not.
    inside() {
      docker run --rm --platform linux/amd64 \
        -v "$ROOT:/native-root" -v "$volume:/work" -v "$REPOSITORY:/repository:ro" \
        -e MARFA_NATIVE_ROOT=/native-root -e MARFA_NATIVE_WORK=/work -e CARGO_HOME=/work/cargo-home \
        -e MARFA_KEEP_WORK="${MARFA_KEEP_WORK:-}" \
        "$image" "$@"
    }
    here=/repository/core/marfa-enrichment/native
    stage "build the libraries (native/build.sh), in the image"
    inside "$here/build.sh" "$TARGET"
    if [ -n "$server" ]; then
      stage "build the server (native/server.sh), in the image"
      inside "$here/server.sh" "$TARGET"
      inside chown -R "$(id -u):$(id -g)" /native-root
      exit 0
    fi
    stage "build, link and check the programs (native/program.sh), in the image"
    inside "$here/program.sh" "$TARGET"
    stage "gather the licences (native/licenses.sh), in the image"
    inside "$here/licenses.sh" "$TARGET"
    # The image runs as root, so what it wrote is root's. The checks that follow run as
    # the host's user (a runner's `runner`) and make folders beside the programs.
    inside chown -R "$(id -u):$(id -g)" /native-root
    ;;
esac

stage "read a file with the finished program, with nothing else installed"
shipped="$OUT/marfa-enrichment-read"
sample="$CRATE/fixtures/sentence.png"
[ -f "$sample" ] || die "no $sample"
case "$TARGET" in
  aarch64-apple-darwin)
    said=$(env -i "$shipped" read "$sample" 2>&1) || die "the program could not read $sample: $said"
    ;;
  *)
    case "$TARGET" in aarch64-*) platform=linux/arm64 ;; *) platform=linux/amd64 ;; esac
    # An emulator cannot install the reader's seccomp filter, so the reader refuses to read
    # there; the read waits for a machine that runs the program itself.
    case "$(uname -m):$platform" in
      arm64:linux/arm64 | aarch64:linux/arm64 | x86_64:linux/amd64) ;;
      *) platform= ;;
    esac
    if [ -z "$platform" ]; then
      echo "release: $TARGET does not run on this machine (the machine is $(uname -m)); the sample is read by a machine that runs it"
      said=
    else
      smoke="$ROOT/work/smoke-$TARGET"
      rm -rf "$smoke"
      mkdir -p "$smoke"
      cp "$shipped" "$smoke/marfa-enrichment-read"
      cp "$sample" "$smoke/sentence.png"
      printf 'FROM scratch\nCOPY marfa-enrichment-read sentence.png /\n' >"$smoke/Dockerfile"
      docker build --quiet --platform "$platform" -t "$prefix-smoke" "$smoke" >/dev/null || die "could not build the smoke image"
      said=$(docker run --rm --platform "$platform" --read-only --user 65534:65534 "$prefix-smoke" \
        /marfa-enrichment-read read /sentence.png 2>&1) \
        || { docker rmi "$prefix-smoke" >/dev/null 2>&1; die "the program could not read the sample: $said"; }
      docker rmi "$prefix-smoke" >/dev/null 2>&1 || true
      rm -rf "$smoke"
    fi
    ;;
esac
if [ -n "$said" ]; then
  echo "$said" | head -5
  echo "$said" | grep -q "Marfa reads this sentence upright." || die "the program read the sample but did not find its text"
fi

if [ -n "$full" ]; then
  stage "verify the programs on the whole matrix (native/verify.sh)"
  "$NATIVE_DIR/verify.sh" "$TARGET"
fi

stage "done"
echo "release: $TARGET finished in $((SECONDS - started)) seconds"
echo "release: $(wc -c <"$shipped") bytes  $shipped"
echo "release: $(wc -c <"$PREFIX/lib/libpdfium.a") bytes  $PREFIX/lib/libpdfium.a"
echo "release: licences  $OUT/NOTICES.txt"
