#!/usr/bin/env bash
# Holds the framework build.sh made to the systems it declares. In each
# slice every object is built for that slice's platform and needs no newer
# system than build.sh names, and the newest any of them needs is exactly
# that one, which is what shows the deployment targets reached the compilers.
#
#   bindings/swift/check-targets.sh     # after build.sh
set -euo pipefail
cd "$(dirname "$0")"

macos="$(sed -n 's/^macos=//p' build.sh)"
ios="$(sed -n 's/^ios=//p' build.sh)"
if [[ -z "${macos}" || -z "${ios}" ]]; then
  echo "check-targets.sh: build.sh names no macos= or ios= target" >&2
  exit 1
fi
framework=MarfaCore/MarfaCoreFFI.xcframework

# The platform numbers a Mach-O build version carries (<mach-o/loader.h>).
failed=0
check() {
  local slice=$1 platform=$2 name=$3 target=$4
  local library="${framework}/${slice}/libmarfa_core_ffi.a"
  if [[ ! -f "${library}" ]]; then
    echo "check-targets.sh: ${library} is missing; run build.sh first" >&2
    failed=1
    return
  fi
  # Each member's minimum system, as "member platform version", one a line.
  # Newer objects carry it in LC_BUILD_VERSION; the ones Rust's standard
  # library ships prebuilt for the phone still carry LC_VERSION_MIN_*.
  local members versions
  members="$(otool -l "${library}" | grep -c '\.o):$')"
  versions="$(otool -l "${library}" | awk '
    /\.o\):$/ { member = $0; next }
    $1 == "cmd" {
      kind = $2
      platform = kind == "LC_VERSION_MIN_MACOSX" ? 1 : kind == "LC_VERSION_MIN_IPHONEOS" ? 2 : ""
      next
    }
    kind == "LC_BUILD_VERSION" && $1 == "platform" { platform = $2; next }
    kind == "LC_BUILD_VERSION" && $1 == "minos" { print member, platform, $2; kind = ""; next }
    kind ~ /^LC_VERSION_MIN_/ && $1 == "version" { print member, platform, $2; kind = "" }
  ')"
  local report
  report="$(awk -v want="${platform}" -v target="${target}" -v members="${members}" '
    function value(version, parts) { split(version, parts, "."); return parts[1] * 1000 + parts[2] }
    {
      count++
      if ($2 != want) wrong++
      if (value($3) > value(target)) { newer++; if (!example) example = $1 " needs " $3 }
      if (value($3) > value(highest)) highest = $3
    }
    END {
      if (count == 0) { print "no objects with a minimum system"; exit 1 }
      if (count != members) { print members - count " of " members " objects name no minimum system"; exit 1 }
      if (wrong) { print wrong " of " count " objects are for another platform"; exit 1 }
      if (newer) { print newer " of " count " objects need a system newer than " target ", " example; exit 1 }
      if (value(highest) != value(target)) { print "the newest any of " count " objects needs is " highest ", not " target; exit 1 }
      print count " objects, none needing a system newer than " target
    }
  ' <<<"${versions}")" || {
    echo "check-targets.sh: ${slice}: ${report}" >&2
    failed=1
    return
  }
  echo "${slice} (${name} ${target}): ${report}"
}

check macos-arm64 1 macOS "${macos}.0"
check ios-arm64 2 iOS "${ios}.0"
check ios-arm64-simulator 7 "iOS simulator" "${ios}.0"
exit "${failed}"
