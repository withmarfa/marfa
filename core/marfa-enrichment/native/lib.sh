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
# prefix for each. The root is named by the caller, never guessed.
select_root() {
  [ -n "${MARFA_NATIVE_ROOT:-}" ] || die "set MARFA_NATIVE_ROOT to the folder for downloads, work and the prefix"
  mkdir -p "$MARFA_NATIVE_ROOT"
  ROOT=$(cd "$MARFA_NATIVE_ROOT" && pwd)
  DOWNLOADS="$ROOT/downloads"
  WORK="$ROOT/work/$TARGET"
  PREFIX="$ROOT/prefix/$TARGET"
  mkdir -p "$DOWNLOADS" "$WORK" "$PREFIX/lib" "$PREFIX/include" "$PREFIX/tessdata"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fields <kind> <name>: the manifest line for a pin, split into one word per
# line after the kind and name.
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
  local part="$file.part"
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
  [ -f "$folder/python3_bin_reldir.txt" ] && return 0
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
}

# need <tool>...: stops with a clear message for the first one missing.
need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on PATH"
  done
}

# musl_into <toolchain> <folder>: the musl cross compiler pinned for a Linux
# target, unpacked into a new <folder>. It runs on x86_64 Linux only.
musl_into() {
  local name=$1 folder=$2
  local _kind _name url sha
  read -r _kind _name url sha <<<"$(manifest_line tool "$name")"
  local file="$DOWNLOADS/$name.tgz"
  download "$url" "$sha" "$file"
  rm -rf "$folder"
  mkdir -p "$folder"
  tar -xzf "$file" -C "$folder" --strip-components=1
}
