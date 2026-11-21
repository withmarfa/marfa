#!/usr/bin/env bash
# Writes the licences of the Go modules compiled into the pinned `cloudflared`, for NOTICES.txt.
#
#   cloudflared-licences.sh <output file>
#
# It fetches the pinned build of every target (each download is held to cloudflared.txt), reads the
# modules `go version -m` lists for it, downloads each module at that version through the Go module
# proxy, which checks it against Go's checksum database, and copies the licence files from the
# module's top folder. The output is committed as `cloudflared-licences.txt`, and its hash is
# pinned in cloudflared.txt. Needs go, curl, tar and awk. Run it when the pin moves.
#
# The shape of the output is what `fetch-cloudflared.sh` reads: a line `=== <module> <version> ===`
# opens each entry, and `=== go <version> ===` opens the Go standard library's.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=cloudflared-pins.sh
source "$here/cloudflared-pins.sh"
# shellcheck source=cloudflared-modules.sh
source "$here/cloudflared-modules.sh"

[ $# -eq 1 ] || {
  echo "usage: cloudflared-licences.sh <output file>" >&2
  exit 2
}
output=$1

fail() {
  echo "::error::$*" >&2
  exit 1
}

for tool in go curl tar awk; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is needed to gather the licences."
done

version=$(pin_of version)
downloads=${MARFA_CLOUDFLARED_DOWNLOADS:-https://github.com/cloudflare/cloudflared/releases/download/$version}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The modules and the Go release of every build the release carries.
: > "$work/modules"
: > "$work/goversions"
while read -r target asset download_sha program_sha; do
  echo "licences: read the modules of $target"
  curl --fail --silent --show-error --location --retry 2 --output "$work/$asset" "$downloads/$asset" \
    || fail "could not download $asset."
  [ "$(sha256_of "$work/$asset")" = "$download_sha" ] || fail "$asset is not the download $(basename "$pins_file") names."
  program="$work/$asset"
  case "$asset" in
    *.tgz)
      mkdir "$work/$target"
      tar -xzf "$work/$asset" -C "$work/$target" cloudflared
      program="$work/$target/cloudflared"
      ;;
  esac
  [ "$(sha256_of "$program")" = "$program_sha" ] || fail "the program in $asset is not the one $(basename "$pins_file") names."
  go version -m "$program" | go_modules >> "$work/modules"
  go version -m "$program" | go_release >> "$work/goversions"
done < <(awk '$1 == "download" { print $2, $3, $4, $5 }' "$pins_file")
sort -u "$work/modules" -o "$work/modules"
[ "$(sort -u "$work/goversions" | wc -l | tr -d ' ')" = 1 ] || fail "the builds name more than one Go release: $(sort -u "$work/goversions" | tr '\n' ' ')"
go_release=$(sort -u "$work/goversions")

export GOMODCACHE="$work/modcache" GOFLAGS=-modcacherw GOTOOLCHAIN=local

# licence_files <folder>: the licence files in a module's top folder, one path a line.
licence_files() {
  find "$1" -maxdepth 1 -type f \( -iname 'licen[cs]e*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'patents*' -o -iname 'unlicense*' \) | LC_ALL=C sort
}

{
  printf '%s\n' "The licences of the Go modules compiled into cloudflared $version, and of the Go standard library."
  printf '%s\n' "Each module is at the version its program names, and each text is the licence file in the module's top folder."
  printf '%s\n' "Made by scripts/release/cloudflared-licences.sh."
  printf '\n'
  printf '=== go %s ===\n' "$go_release"
  curl --fail --silent --show-error --location --retry 2 "https://raw.githubusercontent.com/golang/go/$go_release/LICENSE" \
    || fail "could not download the Go licence for $go_release."
  printf '\n'
  while read -r path module_version; do
    echo "licences: $path $module_version" >&2
    folder=$(go mod download -json "$path@$module_version" | awk -F'"' '$2 == "Dir" { print $4 }')
    [ -n "$folder" ] && [ -d "$folder" ] || fail "could not download $path $module_version."
    files=$(licence_files "$folder")
    [ -n "$files" ] || fail "$path $module_version has no licence file in its top folder."
    printf '=== %s %s ===\n' "$path" "$module_version"
    while IFS= read -r file; do
      printf -- '--- %s ---\n' "$(basename "$file")"
      cat "$file"
      printf '\n'
    done <<< "$files"
  done < "$work/modules"
} > "$work/licences.txt"
mv "$work/licences.txt" "$output"
echo "licences: $(wc -l < "$work/modules" | tr -d ' ') modules in $output"
echo "licences: sha256 $(sha256_of "$output")"
