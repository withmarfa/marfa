#!/bin/bash
# Reads mutated copies of real PDFs, pictures and Office files through the real
# program of a target, to find a file that crashes, hangs or exhausts the memory of a
# reader. The parent must survive all of them; each file that harms a reader is kept.
#
#   MARFA_NATIVE_ROOT=<folder> native/fuzz.sh <target> <seconds> [--findings <folder>] [--jobs <n>] [--seed <n>]
#                              [--max-memory <bytes>]
#
# The seeds are the test files of native/verify.sh (run that first), without its
# damaged and oversized ones. On Linux the run is in a `FROM scratch` container with
# the read-only root file system and an unprivileged user, and a writable folder only
# for the findings. The numbers and the findings are printed and kept in
# $MARFA_NATIVE_ROOT/out/<target>/fuzz/. A run with the same --seed and --jobs repeats
# up to where it stopped (src/bin/marfa-enrichment-fuzz.rs says how a file is chosen).
# Needs docker on Linux, and the output of native/program.sh and native/verify.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

set -o pipefail
select_target "${1:-}"
seconds=${2:?seconds to run}
shift 2
jobs=2
seed=1
findings=
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --findings) findings=$2; shift 2 ;;
    --jobs) jobs=$2; shift 2 ;;
    --seed) seed=$2; shift 2 ;;
    --max-memory) extra=(--max-memory "$2"); shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
select_root

OUT="$ROOT/out/$TARGET"
F="$OUT/fuzz"
[ -x "$OUT/marfa-enrichment-fuzz" ] || die "no fuzz program in $OUT; run native/program.sh $TARGET first"
[ -d "$OUT/verify/context/files" ] || die "no test files in $OUT/verify; run native/verify.sh $TARGET first"
findings=${findings:-$F/findings}

chmod -R u+w "$F" 2>/dev/null || true
rm -rf "$F/seeds" "$F/context"
mkdir -p "$F/seeds" "$findings"
for file in "$OUT/verify/context/files/"* "$OUT/verify/context/files/corpus/"*; do
  [ -f "$file" ] || continue
  case "$(basename "$file")" in
    big-text.png | deep.xml | empty.pdf | not-a-* | random.png | truncated* | good.txt | encrypted.pdf) continue ;;
  esac
  cp "$file" "$F/seeds/"
done
echo "fuzz: $(ls "$F/seeds" | wc -l | tr -d ' ') seed files, $seconds seconds, $jobs jobs, seed $seed, $TARGET"

started=$(date +%s)
case "$TARGET" in
  aarch64-apple-darwin)
    code=0
    env -i "$OUT/marfa-enrichment-fuzz" "$F/seeds" "$findings" --seconds "$seconds" --jobs "$jobs" --seed "$seed" ${extra[@]+"${extra[@]}"} \
      2>&1 | tee "$F/run.log" || code=$?
    ;;
  *)
    need docker
    case "$TARGET" in aarch64-*) platform=linux/arm64 ;; *) platform=linux/amd64 ;; esac
    image=${MARFA_VERIFY_IMAGE:-marfa-enrichment-verify}-fuzz-${TARGET%%-*}
    mkdir -p "$F/context"
    cp "$OUT/marfa-enrichment-fuzz" "$F/context/"
    cp -R "$F/seeds" "$F/context/seeds"
    printf 'FROM scratch\nCOPY marfa-enrichment-fuzz /\nCOPY seeds /seeds\n' >"$F/context/Dockerfile"
    docker build --quiet --platform "$platform" -t "$image" "$F/context" >/dev/null || die "could not build $image"
    trap 'docker rmi "$image" >/dev/null 2>&1 || true' EXIT
    code=0
    docker run --rm --platform "$platform" --read-only --user "$(id -u):$(id -g)" \
      -v "$findings:/findings" "$image" /marfa-enrichment-fuzz /seeds /findings \
      --seconds "$seconds" --jobs "$jobs" --seed "$seed" ${extra[@]+"${extra[@]}"} 2>&1 | tee "$F/run.log" || code=$?
    ;;
esac
echo "fuzz: finished after $(($(date +%s) - started)) seconds; findings are in $findings"
ls "$findings" | sed -n 1,20p
exit "$code"
