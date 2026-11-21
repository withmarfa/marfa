#!/usr/bin/env bash
# Puts the pinned `cloudflared` for a build target beside the programs in a release folder, and
# adds its licence to the folder's NOTICES.txt. Run after the notices are written.
#
#   fetch-cloudflared.sh <target> <folder holding NOTICES.txt>
#
# The download and the program inside it must each match `cloudflared.txt`, and on a Mac the
# program must be signed by the team that file names. Cloudflare's own signature is kept: signing
# the program again would change the bytes the pin names.
#
# MARFA_CLOUDFLARED_DOWNLOADS and MARFA_CLOUDFLARED_LICENCE_URL replace the two addresses, for the
# script's own tests.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=cloudflared-pins.sh
source "$here/cloudflared-pins.sh"

[ $# -eq 2 ] || {
  echo "usage: fetch-cloudflared.sh <target> <folder>" >&2
  exit 2
}
target=$1
folder=$2

fail() {
  echo "::error::$*"
  exit 1
}

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

version=$(pin_of version)
licence_sha=$(pin_of licence)
download=$(pin_download "$target")
read -r asset download_sha program_sha <<< "$download"
for hash in "$licence_sha" "$download_sha" "$program_sha"; do
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || fail "$pins_file holds '$hash', which is not 64 lowercase hexadecimal digits."
done
[ -s "$folder/NOTICES.txt" ] || fail "$folder/NOTICES.txt is not a non-empty file; write the notices first."
if grep -q '^cloudflared .*: Apache-2.0$' "$folder/NOTICES.txt"; then
  fail "$folder/NOTICES.txt already carries the cloudflared notice."
fi

downloads=${MARFA_CLOUDFLARED_DOWNLOADS:-https://github.com/cloudflare/cloudflared/releases/download/$version}
licence_url=${MARFA_CLOUDFLARED_LICENCE_URL:-https://raw.githubusercontent.com/cloudflare/cloudflared/$version/LICENSE}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() {
  curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 \
    --speed-limit 20000 --speed-time 60 --output "$2" "$1" \
    || fail "could not download $1."
}

hold() {
  local what=$1 file=$2 want=$3 got
  got=$(sha256_of "$file")
  [ "$got" = "$want" ] || fail "$what is $got, not the $want that $(basename "$pins_file") names."
}

echo "cloudflared: fetch $asset $version"
fetch "$downloads/$asset" "$work/$asset"
hold "$asset" "$work/$asset" "$download_sha"

program="$work/$asset"
case "$asset" in
  *.tgz)
    listed=$(tar -tzf "$work/$asset" | sed 's|^\./||')
    [ "$listed" = cloudflared ] || fail "$asset holds '$listed', not just cloudflared."
    mkdir "$work/unpacked"
    tar -xzf "$work/$asset" -C "$work/unpacked" cloudflared
    program="$work/unpacked/cloudflared"
    ;;
esac
[ -f "$program" ] && [ ! -L "$program" ] || fail "$asset holds no cloudflared file."
hold "the cloudflared program in $asset" "$program" "$program_sha"

case "$target" in
  *-apple-darwin)
    team=$(pin_of team)
    codesign --verify --strict "$program" || fail "the cloudflared program's signature does not verify."
    details=$(codesign -dv "$program" 2>&1)
    if ! grep -qx "TeamIdentifier=$team" <<< "$details" || ! grep -q '(runtime)' <<< "$details"; then
      fail "the cloudflared program is not signed by team $team under the hardened runtime: $details"
    fi
    ;;
esac

echo "cloudflared: fetch the licence"
fetch "$licence_url" "$work/LICENSE"
hold "cloudflared's LICENSE" "$work/LICENSE" "$licence_sha"

mkdir -p "$folder"
cp "$program" "$folder/cloudflared.part"
chmod +x "$folder/cloudflared.part"
mv "$folder/cloudflared.part" "$folder/cloudflared"
{
  printf '\n%s\n' "=============================================================================="
  printf 'cloudflared %s: Apache-2.0\n' "$version"
  printf 'Source of the text: LICENSE of cloudflare/cloudflared at the tag %s\n' "$version"
  printf '%s\n' "=============================================================================="
  printf 'This archive carries cloudflared unchanged, as Cloudflare released it. The licences of the\n'
  printf 'Go modules it is built from are named by go.mod at https://github.com/cloudflare/cloudflared/tree/%s\n\n' "$version"
  cat "$work/LICENSE"
  printf '\n'
} >> "$folder/NOTICES.txt"
echo "cloudflared: $version in $folder/cloudflared ($(wc -c < "$folder/cloudflared" | tr -d ' ') bytes)"
