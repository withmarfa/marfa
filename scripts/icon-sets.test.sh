#!/usr/bin/env bash
# Exercises generation and input failures against a local registry fixture.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-icon-sets-test.XXXXXX")"
trap 'rm -rf -- "${work}"' EXIT

registry="${work}/registry/@iconify-json/demo/-"
mkdir -p -- "${registry}" "${work}/registry/@iconify-json/second/-"

# The fixture tarball uses npm's package/ directory.
make_tarball() { # prefix version file [set]
  local set="${4:-demo}" source="${work}/source-${4:-demo}-$3"
  mkdir -p -- "${source}/package"
  printf '{"name": "@iconify-json/%s", "version": "%s"}' "${set}" "$2" >"${source}/package/package.json"
  printf '{"prefix": "%s", "icons": {"a": {"body": "x"}, "b": {"body": "x", "hidden": true}}, "aliases": {"c": {"parent": "a"}, "d": {"parent": "b"}, "e": {"parent": "f"}, "f": {"parent": "e"}}}' \
    "$1" >"${source}/package/icons.json"
  tar -czf "${work}/registry/@iconify-json/${set}/-/${set}-$3.tgz" -C "${source}" package
}
integrity_of() { echo "sha512-$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"; }

fail() {
  echo "icon-sets.test: $*" >&2
  exit 1
}

# Runs the script with the pin lines given; `expected` is `ok` or text its refusal must hold.
# The sets the script requires are `demo` unless `sets` is set; `sets=default` leaves the script's own.
sets=demo
attempt() { # name expected lines
  local out="${work}/out-$1"
  mkdir -p -- "${out}"
  printf 'earlier' >"${out}/icon-set-demo.json"
  printf '%s\n' "$3" >"${work}/pins-$1"
  local status=0 log
  if [[ "${sets}" == default ]]; then
    log="$(env -u ICON_SET_PREFIXES ICON_SET_PINS="${work}/pins-$1" ICON_SET_REGISTRY="file://${work}/registry" \
      "${here}/icon-sets.sh" "${out}" 2>&1)" || status=$?
  else
    log="$(ICON_SET_PREFIXES="${sets}" ICON_SET_PINS="${work}/pins-$1" ICON_SET_REGISTRY="file://${work}/registry" \
      "${here}/icon-sets.sh" "${out}" 2>&1)" || status=$?
  fi
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

# The pins must name exactly the sets the script writes, so a removed pin cannot pass on files already there.
make_tarball second 1.0.0 1.0.0 second
second_pinned="$(integrity_of "${work}/registry/@iconify-json/second/-/second-1.0.0.tgz")"
sets="demo second"
attempt missing-pin 'pins no line for second' "demo 1.0.0 ${pinned}"
sets=demo
attempt unknown-pin 'pins second, which is not a set the script writes' "$(printf 'demo 1.0.0 %s\nsecond 1.0.0 %s' "${pinned}" "${second_pinned}")"
attempt repeated-pin 'pins demo more than once' "$(printf 'demo 1.0.0 %s\ndemo 1.0.0 %s' "${pinned}" "${pinned}")"
sets=default
real_pins="$(grep -v '^simple-icons' "${here}/icon-sets.txt")"
attempt real-pins-without-simple-icons 'pins no line for simple-icons' "${real_pins}"
sets=demo

# Both icon sets are published together: when the second cannot be put in place the first is as it was.
shim="${work}/shim"
mkdir -p -- "${shim}"
real_mv="$(command -v mv)"
cat >"${shim}/mv" <<SHIM
#!/usr/bin/env bash
count="\$(cat "${work}/mv-count" 2>/dev/null || echo 0)"
echo \$((count + 1)) >"${work}/mv-count"
if [[ "\${count}" -eq 1 ]]; then
  echo "mv: simulated failure" >&2
  exit 1
fi
exec "${real_mv}" "\$@"
SHIM
chmod +x "${shim}/mv"
out="${work}/out-two"
mkdir -p -- "${out}"
printf 'earlier-demo' >"${out}/icon-set-demo.json"
printf 'earlier-second' >"${out}/icon-set-second.json"
printf 'demo 1.0.0 %s\nsecond 1.0.0 %s\n' "${pinned}" "${second_pinned}" >"${work}/pins-two"
status=0
log="$(PATH="${shim}:${PATH}" ICON_SET_PREFIXES="demo second" ICON_SET_PINS="${work}/pins-two" \
  ICON_SET_REGISTRY="file://${work}/registry" "${here}/icon-sets.sh" "${out}" 2>&1)" || status=$?
[[ ${status} -ne 0 ]] || fail "second-rename-fails: expected a refusal"
[[ "$(cat "${out}/icon-set-demo.json")" == earlier-demo ]] || fail "second-rename-fails: the first set was replaced: ${log}"
[[ "$(cat "${out}/icon-set-second.json")" == earlier-second ]] || fail "second-rename-fails: the second set changed"
[[ "$(ls -A "${out}")" == "$(printf 'icon-set-demo.json\nicon-set-second.json')" ]] || fail "second-rename-fails: left a file behind: $(ls -A "${out}")"
echo "ok: second-rename-fails"
rm -f -- "${work}/mv-count"
status=0
log="$(ICON_SET_PREFIXES="demo second" ICON_SET_PINS="${work}/pins-two" ICON_SET_REGISTRY="file://${work}/registry" \
  "${here}/icon-sets.sh" "${out}" 2>&1)" || status=$?
[[ ${status} -eq 0 ]] || fail "both-sets: expected success, got: ${log}"
[[ "$(cat "${out}/icon-set-demo.json")" != earlier-demo && "$(cat "${out}/icon-set-second.json")" != earlier-second ]] || fail "both-sets: an output was not written"
[[ "$(ls -A "${out}")" == "$(printf 'icon-set-demo.json\nicon-set-second.json')" ]] || fail "both-sets: left a file behind: $(ls -A "${out}")"
echo "ok: both-sets"
echo "icon-sets.test: every case held"
