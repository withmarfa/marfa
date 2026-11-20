#!/usr/bin/env bash
# Usage: scripts/icon-sets.sh [output folder]
# The release pins and integrity hashes are in scripts/icon-sets.txt.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pins="${ICON_SET_PINS:-${root}/scripts/icon-sets.txt}"
registry="${ICON_SET_REGISTRY:-https://registry.npmjs.org}"
out="${1:-${root}/packages/types/generated}"

proto='=https'
case "${registry}" in file://*) proto='=file' ;; esac

work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-icon-sets.XXXXXX")"
trap 'rm -rf -- "${work}"' EXIT
mkdir -- "${work}/written"

written=()
while read -r prefix version integrity extra; do
  case "${prefix}" in '' | '#'*) continue ;; esac
  if [[ -z "${integrity}" || -n "${extra}" ]]; then
    echo "icon-sets: ${pins}: the line for ${prefix} is not \"prefix version integrity\"" >&2
    exit 1
  fi
  package="@iconify-json/${prefix}"
  url="${registry}/${package}/-/${prefix}-${version}.tgz"
  folder="${work}/${prefix}"
  mkdir -- "${folder}"

  if ! curl --fail --silent --show-error --retry 3 --connect-timeout 20 --max-time 300 \
    --proto "${proto}" --output "${folder}/set.tgz" "${url}"; then
    echo "icon-sets: could not download ${package} ${version} from ${url}" >&2
    exit 1
  fi

  actual="sha512-$(openssl dgst -sha512 -binary "${folder}/set.tgz" | openssl base64 -A)"
  if [[ "${actual}" != "${integrity}" ]]; then
    echo "icon-sets: ${package} ${version} does not match its pinned integrity" >&2
    echo "  pinned: ${integrity}" >&2
    echo "  actual: ${actual}" >&2
    exit 1
  fi

  mkdir -- "${folder}/files"
  if ! tar -xzf "${folder}/set.tgz" -C "${folder}/files" package/package.json package/icons.json; then
    echo "icon-sets: ${package} ${version} is not a tarball holding package.json and icons.json" >&2
    exit 1
  fi

  file="icon-set-${prefix}.json"
  (
    cd "${root}/core"
    cargo run --quiet --locked -p marfa-rules --example icon_set -- \
      "${folder}/files/package/package.json" "${folder}/files/package/icons.json" \
      "${prefix}" "${package}" "${version}" "${work}/written/${file}"
  )
  written+=("${file}")
done <"${pins}"

if [[ ${#written[@]} -eq 0 ]]; then
  echo "icon-sets: ${pins} pins no set" >&2
  exit 1
fi

mkdir -p -- "${out}"
for file in "${written[@]}"; do
  cp -- "${work}/written/${file}" "${out}/${file}.partial"
  mv -- "${out}/${file}.partial" "${out}/${file}"
done
echo "icon-sets: wrote ${written[*]} to ${out}"
