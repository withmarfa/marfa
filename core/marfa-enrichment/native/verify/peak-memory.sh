#!/bin/bash
# Measures what a Linux program's readers hold: the most address space (VmPeak) and
# resident memory (VmHWM) any `marfa-enrichment` process reaches during one run, and
# the address-space limit that process was given. A container from `FROM scratch` has
# no shell or /proc tools, so a second container that shares the host's process table
# watches from outside.
#
#   native/verify/peak-memory.sh <image> <platform> <program> <args...>
#
# Prints one line: `peak vmpeak_kb=... vmhwm_kb=... rlimit_as=...`. Needs docker and the
# alpine image. The reader is the program started again from /proc/self/exe, whose name is `exe`.
set -eu
image=$1 platform=$2
shift 2
watcher=$(docker run -d --rm --pid=host --platform "$platform" alpine sh -c '
  peak=0; hwm=0; limit=unknown
  while :; do
    for p in $(pidof exe 2>/dev/null); do
      set -- $(awk "/^VmPeak/ { v = \$2 } /^VmHWM/ { h = \$2 } END { print v, h }" "/proc/$p/status" 2>/dev/null)
      [ -n "${1:-}" ] && [ "$1" -gt "$peak" ] && peak=$1
      [ -n "${2:-}" ] && [ "$2" -gt "$hwm" ] && hwm=$2
      l=$(awk "/Max address space/ { print \$4 }" "/proc/$p/limits" 2>/dev/null)
      [ -n "$l" ] && [ "$l" != unlimited ] && limit=$l
      echo "peak vmpeak_kb=$peak vmhwm_kb=$hwm rlimit_as=$limit" >/tmp/peak
    done
  done')
sleep 1
docker run --rm --platform "$platform" --read-only --user 65534:65534 "$image" "$@" >/dev/null 2>&1 || true
sleep 0.5
docker exec "$watcher" cat /tmp/peak 2>/dev/null || echo "peak: nothing seen"
docker rm -f "$watcher" >/dev/null 2>&1 || true
