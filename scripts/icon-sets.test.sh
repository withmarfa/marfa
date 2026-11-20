#!/usr/bin/env bash
# Runs scripts/icon-sets.sh against a registry on disk: the pinned set is written, and every way
# the run can go wrong refuses and leaves the output folder as it was.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-icon-sets-test.XXXXXX")"
trap 'rm -rf -- "${work}"' EXIT

registry="${work}/registry/@iconify-json/demo/-"
mkdir -p -- "${registry}"

# A tarball of a set, as npm lays it out, and the line that pins it.
make_tarball() { # prefix version file
  local source="${work}/source-$3"
  mkdir -p -- "${source}/package"
  printf '{"name": "@iconify-json/demo", "version": "%s"}' "$2" >"${source}/package/package.json"
  printf '{"prefix": "%s", "icons": {"a": {"body": "x"}, "b": {"body": "x", "hidden": true}}, "aliases": {"c": {"parent": "a"}, "d": {"parent": "b"}, "e": {"parent": "f"}, "f": {"parent": "e"}}}' \
    "$1" >"${source}/package/icons.json"
  tar -czf "${registry}/demo-$3.tgz" -C "${source}" package
}
integrity_of() { echo "sha512-$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"; }

fail() {
  echo "icon-sets.test: $*" >&2
  exit 1
}

# Runs the script with one pin line; `expected` is `ok` or text its refusal must hold.
attempt() { # name expected line
  local out="${work}/out-$1"
  mkdir -p -- "${out}"
  printf 'earlier' >"${out}/icon-set-demo.json"
  printf '%s\n' "$3" >"${work}/pins-$1"
  local status=0 log
  log="$(ICON_SET_PINS="${work}/pins-$1" ICON_SET_REGISTRY="file://${work}/registry" \
    "${here}/icon-sets.sh" "${out}" 2>&1)" || status=$?
  if [[ "$2" == ok ]]; then
    [[ ${status} -eq 0 ]] || fail "$1: expected success, got: ${log}"
    [[ "$(cat "${out}/icon-set-demo.json")" != earlier ]] || fail "$1: output was not written"
  else
    [[ ${status} -ne 0 ]] || fail "$1: expected a refusal"
    grep -q -- "$2" <<<"${log}" || fail "$1: refusal did not hold \"$2\": ${log}"
    [[ "$(cat "${out}/icon-set-demo.json")" == earlier ]] || fail "$1: output changed on a refusal"
    [[ "$(ls "${out}")" == icon-set-demo.json ]] || fail "$1: left a file behind: $(ls "${out}")"
  fi
  echo "ok: $1"
}

make_tarball demo 1.0.0 1.0.0
pinned="$(integrity_of "${registry}/demo-1.0.0.tgz")"
attempt success ok "demo 1.0.0 ${pinned}"
grep -q '"c": "a"' "${work}/out-success/icon-set-demo.json" || fail "the alias to a listed icon is missing"
if grep -q '"d"\|"e"\|"f"\|"b"' "${work}/out-success/icon-set-demo.json"; then
  fail "a hidden icon, an alias to one or an alias cycle was written"
fi

attempt wrong-integrity 'does not match its pinned integrity' "demo 1.0.0 sha512-AAAA"
attempt unreachable 'could not download' "demo 9.9.9 ${pinned}"

head -c 100 "${registry}/demo-1.0.0.tgz" >"${registry}/demo-1.0.1.tgz"
attempt partial-download 'is not a tarball' "demo 1.0.1 $(integrity_of "${registry}/demo-1.0.1.tgz")"
attempt partial-download-wrong-hash 'does not match its pinned integrity' "demo 1.0.1 ${pinned}"

make_tarball other 1.0.2 1.0.2
attempt wrong-prefix 'holds the set "other"' "demo 1.0.2 $(integrity_of "${registry}/demo-1.0.2.tgz")"

make_tarball demo 1.0.4 1.0.3
attempt wrong-version 'not the pinned' "demo 1.0.3 $(integrity_of "${registry}/demo-1.0.3.tgz")"

attempt malformed-pin 'is not "prefix version integrity"' "demo 1.0.0"
echo "icon-sets.test: every case held"
