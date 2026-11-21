#!/usr/bin/env bash
# Usage: scripts/icon-sets.sh [output folder]
# The release pins and integrity hashes are in scripts/icon-sets.txt, which must pin each set once.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pins="${ICON_SET_PINS:-${root}/scripts/icon-sets.txt}"
registry="${ICON_SET_REGISTRY:-https://registry.npmjs.org}"
out="${1:-${root}/core/marfa-rules/icons}"
prefixes="${ICON_SET_PREFIXES:-lucide simple-icons}"

proto='=https'
case "${registry}" in file://*) proto='=file' ;; esac

work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-icon-sets.XXXXXX")"
staged=()
cleanup() {
  rm -rf -- "${work}"
  if [[ ${#staged[@]} -gt 0 ]]; then
    rm -f -- "${staged[@]}"
  fi
}
trap cleanup EXIT
mkdir -- "${work}/written"

# The pins name each set the script writes, once, so a missing pin cannot pass on files already there.
seen=" "
while read -r prefix version integrity extra; do
  case "${prefix}" in '' | '#'*) continue ;; esac
  if [[ -z "${integrity}" || -n "${extra}" ]]; then
    echo "icon-sets: ${pins}: the line for ${prefix} is not \"prefix version integrity\"" >&2
    exit 1
  fi
  if [[ " ${prefixes} " != *" ${prefix} "* ]]; then
    echo "icon-sets: ${pins} pins ${prefix}, which is not a set the script writes (${prefixes})" >&2
    exit 1
  fi
  if [[ "${seen}" == *" ${prefix} "* ]]; then
    echo "icon-sets: ${pins} pins ${prefix} more than once" >&2
    exit 1
  fi
  seen="${seen}${prefix} "
done <"${pins}"
for prefix in ${prefixes}; do
  if [[ "${seen}" != *" ${prefix} "* ]]; then
    echo "icon-sets: ${pins} pins no line for ${prefix}" >&2
    exit 1
  fi
done

written=()
while read -r prefix version integrity extra; do
  case "${prefix}" in '' | '#'*) continue ;; esac
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

# Stage every output beside its target, keep what is there, then put each in place; a failure restores it.
mkdir -p -- "${out}"
for file in "${written[@]}"; do
  staged+=("${out}/.${file}.new.$$" "${out}/.${file}.old.$$")
  cp -- "${work}/written/${file}" "${out}/.${file}.new.$$"
  if [[ -e "${out}/${file}" ]]; then
    cp -p -- "${out}/${file}" "${out}/.${file}.old.$$"
  fi
done
published=()
for file in "${written[@]}"; do
  if ! mv -f -- "${out}/.${file}.new.$$" "${out}/${file}"; then
    echo "icon-sets: could not put ${file} in place in ${out}; restoring the sets already written" >&2
    for done_file in ${published[@]+"${published[@]}"}; do
      if [[ -e "${out}/.${done_file}.old.$$" ]]; then
        mv -f -- "${out}/.${done_file}.old.$$" "${out}/${done_file}" || echo "icon-sets: could not restore ${done_file}" >&2
      else
        rm -f -- "${out}/${done_file}"
      fi
    done
    exit 1
  fi
  published+=("${file}")
done
echo "icon-sets: wrote ${written[*]} to ${out}"
