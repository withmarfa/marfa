# Shared by the scripts in this folder. Sourced, never run.

set -eu

NATIVE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST="$NATIVE_DIR/manifest.txt"

die() {
  echo "native: $*" >&2
  exit 1
}

# The targets the scripts know. Each is a Rust target triple.
SUPPORTED_TARGETS="aarch64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl"

# Sets TARGET, and for it the PDFium arguments (PDFIUM_OS, PDFIUM_CPU,
# PDFIUM_ENV) and the CMake system (CMAKE_SYSTEM, CMAKE_PROCESSOR).
select_target() {
  TARGET=${1:-}
  case "$TARGET" in
    aarch64-apple-darwin)
      PDFIUM_OS=mac PDFIUM_CPU=arm64 PDFIUM_ENV=
      CMAKE_SYSTEM=Darwin CMAKE_PROCESSOR=arm64
      MUSL_TOOLCHAIN= MUSL_PREFIX=
      ;;
    aarch64-unknown-linux-musl)
      PDFIUM_OS=linux PDFIUM_CPU=arm64 PDFIUM_ENV=musl
      CMAKE_SYSTEM=Linux CMAKE_PROCESSOR=aarch64
      MUSL_TOOLCHAIN=aarch64-linux-musl-cross MUSL_PREFIX=aarch64-linux-musl-
      ;;
    x86_64-unknown-linux-musl)
      PDFIUM_OS=linux PDFIUM_CPU=x64 PDFIUM_ENV=musl
      CMAKE_SYSTEM=Linux CMAKE_PROCESSOR=x86_64
      MUSL_TOOLCHAIN=x86_64-linux-musl-cross MUSL_PREFIX=x86_64-linux-musl-
      ;;
    *) die "unknown target '$TARGET'; the targets are: $SUPPORTED_TARGETS" ;;
  esac
}

# Where everything goes: downloads shared by all targets, a work folder and a
# prefix for each, and the archives that keep a finished PDFium. The root is named
# by the caller, never guessed. The work folders may live elsewhere, named by
# MARFA_NATIVE_WORK: a PDFium checkout needs a file system that tells `A` from
# `a` and holds many small files, which a Mac's shared folder into a container
# does not.
select_root() {
  [ -n "${MARFA_NATIVE_ROOT:-}" ] || die "set MARFA_NATIVE_ROOT to the folder for downloads, work and the prefix"
  mkdir -p "$MARFA_NATIVE_ROOT"
  ROOT=$(cd "$MARFA_NATIVE_ROOT" && pwd)
  DOWNLOADS="$ROOT/downloads"
  ARCHIVES="$ROOT/archives"
  WORK_ROOT=${MARFA_NATIVE_WORK:-$ROOT/work}
  WORK="$WORK_ROOT/$TARGET"
  PREFIX="$ROOT/prefix/$TARGET"
  mkdir -p "$DOWNLOADS" "$ARCHIVES" "$WORK" "$PREFIX/lib" "$PREFIX/include" "$PREFIX/tessdata"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# manifest_line <kind> <name>: the manifest line for a pin.
manifest_line() {
  local kind=$1 name=$2
  local line
  line=$(awk -v kind="$kind" -v name="$name" '$1 == kind && $2 == name { print; exit }' "$MANIFEST")
  [ -n "$line" ] || die "$MANIFEST has no '$kind $name' line"
  echo "$line"
}

# download <url> <sha256> <file>: fetches into <file> unless a file with that
# hash is already there, and stops if what arrives has another hash.
download() {
  local url=$1 want=$2 file=$3
  if [ -f "$file" ] && [ "$(sha256_of "$file")" = "$want" ]; then
    return 0
  fi
  rm -f "$file"
  local part="$file.part.$$"
  curl --fail --silent --show-error --location --retry 3 --output "$part" "$url" \
    || die "could not fetch $url"
  local got
  got=$(sha256_of "$part")
  if [ "$got" != "$want" ]; then
    rm -f "$part"
    die "hash mismatch for $url: the manifest says $want and the download is $got"
  fi
  mv "$part" "$file"
}

# archive_into <name> <folder>: fetches the archive pinned for <name>, and
# unpacks it, with its top folder removed, into a new empty <folder>.
archive_into() {
  local name=$1 folder=$2
  local _kind _name version url sha
  read -r _kind _name version url sha <<<"$(manifest_line archive "$name")"
  local file="$DOWNLOADS/$name-$(echo "$version" | tr '/' '-').tgz"
  download "$url" "$sha" "$file"
  rm -rf "$folder"
  mkdir -p "$folder"
  tar -xzf "$file" -C "$folder" --strip-components=1
}

# checkout <name> <folder>: a git checkout at exactly the pinned commit.
checkout() {
  local name=$1 folder=$2
  local _kind _name url ref commit
  read -r _kind _name url ref commit <<<"$(manifest_line git "$name")"
  if [ ! -d "$folder/.git" ]; then
    git clone --quiet "$url" "$folder" || die "could not clone $url"
  fi
  git -C "$folder" fetch --quiet origin "$ref" || die "could not fetch $ref of $url"
  git -C "$folder" checkout --quiet --detach "$commit" \
    || die "$url does not hold commit $commit"
}

# bootstrap_depot_tools <folder>: depot_tools fetches its own Python and tools the
# first time one of its commands runs, in a step that also pulls depot_tools to
# its newest commit. The pin forbids that update, so the fetch is done here alone.
bootstrap_depot_tools() {
  local folder=$1
  local done="$folder/.bootstrapped" commit
  commit=$(git -C "$folder" rev-parse HEAD) || die "$folder is not a checkout"
  [ "$(cat "$done" 2>/dev/null)" = "$commit" ] && return 0
  rm -f "$folder/python3_bin_reldir.txt"
  (
    set +u
    export DEPOT_TOOLS_DIR=$folder
    cd "$folder"
    # shellcheck disable=SC1091
    source ./cipd_bin_setup.sh
    cipd_bin_setup
    # shellcheck disable=SC1091
    source ./bootstrap_python3
    bootstrap_python3
  ) >/dev/null || die "could not bootstrap depot_tools in $folder"
  [ -f "$folder/python3_bin_reldir.txt" ] || die "depot_tools did not bootstrap in $folder"
  echo "$commit" >"$done"
}

# need <tool>...: stops with a clear message for the first one missing.
need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on PATH"
  done
}

# tool_into <name> <folder>: the tool pinned as `tool <name>`, unpacked, with its top
# folder removed, into a new empty <folder>. The musl cross compilers run on x86_64
# Linux only.
tool_into() {
  local name=$1 folder=$2
  local _kind _name url sha
  read -r _kind _name url sha <<<"$(manifest_line tool "$name")"
  local file="$DOWNLOADS/$name.tar"
  download "$url" "$sha" "$file"
  rm -rf "$folder"
  mkdir -p "$folder"
  tar -xf "$file" -C "$folder" --strip-components=1
}

# kept_tool <name>: sets KEPT_TOOL to a folder holding the tool pinned as `tool <name>`,
# unpacked once. The folder is named for the hash the manifest pins, so a new pin
# unpacks afresh and never finds an earlier compiler, and the mark written last means
# an unpacking that stopped part way is not taken for a finished one.
kept_tool() {
  local name=$1
  local sha
  sha=$(manifest_line tool "$name" | awk '{ print $4 }')
  KEPT_TOOL="$WORK/$name-$sha"
  [ -f "$KEPT_TOOL.unpacked" ] && return 0
  rm -rf "$WORK/$name" "$WORK/$name"-*
  tool_into "$name" "$KEPT_TOOL"
  : >"$KEPT_TOOL.unpacked"
}

# recipe_hash <kind:name>...: a short hash of the manifest lines and files that decide
# what a saved build holds. A saved archive made from another recipe is not used.
# Each argument is `line:<kind>:<name>` (a manifest line) or `file:<path>`.
recipe_hash() {
  local item
  {
    for item in "$@"; do
      case "$item" in
        line:*)
          local rest=${item#line:}
          manifest_line "${rest%%:*}" "${rest#*:}"
          ;;
        file:*) cat "${item#file:}" ;;
      esac
    done
  } | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16
}

# licence_into <name> <file>: the licence text pinned as `licence <name>`, verified.
licence_into() {
  local name=$1 out=$2
  local _kind _name url sha
  read -r _kind _name url sha <<<"$(manifest_line licence "$name")"
  download "$url" "$sha" "$DOWNLOADS/licence-$name.txt"
  cp "$DOWNLOADS/licence-$name.txt" "$out"
}

# make_build_image <name>: builds the image of native/linux/Dockerfile, the one every
# Linux build and the VM's init program are made in, with the base image and the
# snapshot date the manifest pins.
make_build_image() {
  local image=$1 base snapshot
  base=$(manifest_line image build | awk '{ print $3 }')
  snapshot=$(manifest_line apt-snapshot ubuntu | awk '{ print $3 }')
  docker build --quiet --platform linux/amd64 --build-arg "BASE=$base" --build-arg "SNAPSHOT=$snapshot" \
    -f "$NATIVE_DIR/linux/Dockerfile" -t "$image" "$NATIVE_DIR" >/dev/null || die "could not build $image"
}
