#!/bin/bash
# Builds the proof program, marfa-enrichment-read, for a target from a finished
# prefix, as three files in $MARFA_NATIVE_ROOT/out/<target>/:
#
#   marfa-enrichment-read        what a release ships, stripped
#   marfa-enrichment-read-proof  the same with the `fault-injection` feature, which makes a
#                                reader crash on marked bytes, so verify.sh can prove
#                                that the parent survives. Never ship it.
#   marfa-enrichment-fuzz        reads mutated files through the real reader (native/fuzz.sh).
#                                Never ship it.
#
# Then it checks what it made: the file kind and its libraries, the macOS
# deployment target, and that the shipped file ignores a fault that the proof file obeys.
#
#   MARFA_NATIVE_ROOT=<folder> native/program.sh <target>
#
# Needs the toolchain pinned in the manifest on PATH (cargo and rustc; on Linux the
# image of native/linux/ has it), and on Linux `file` and `readelf`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need cargo rustc

CORE=$(cd "$NATIVE_DIR/../.." && pwd)
OUT="$ROOT/out/$TARGET"
mkdir -p "$OUT"
rm -f "$OUT"/marfa-enrichment-read "$OUT"/marfa-enrichment-read-proof "$OUT"/marfa-enrichment-fuzz

cargo_environment

# build <program> <features> <file>
build() {
  (cd "$CORE" && cargo build --release --locked --target "$TARGET" -p marfa-enrichment \
    --bin "$1" --features "$2")
  cp "$CARGO_TARGET_DIR/$TARGET/release/$1" "$3"
}

build marfa-enrichment-read native "$OUT/marfa-enrichment-read"
MARFA_ENRICHMENT_ALLOW_FAULTS=1 build marfa-enrichment-read native,fault-injection "$OUT/marfa-enrichment-read-proof"
build marfa-enrichment-fuzz native "$OUT/marfa-enrichment-fuzz"

# What was made is what it should be. A program cannot be searched for its fault code:
# the compiler turns the marker into immediate comparisons, so no string is left. It is
# asked instead, where it can run here: a file that asks for a crash gets one from the
# proof program and is read as plain text by the shipped one. A program that cannot run
# on this machine (arm64 Linux built on x86_64) is checked by verify.sh.
shipped="$OUT/marfa-enrichment-read"
proof="$OUT/marfa-enrichment-read-proof"
fault_file="$OUT/fault-check.txt"
printf 'MARFA-ENRICHMENT-FAULT:segfault\n' >"$fault_file"
case "$TARGET:$(uname -s)-$(uname -m)" in
  aarch64-apple-darwin:Darwin-arm64 | x86_64-unknown-linux-musl:Linux-x86_64 | aarch64-unknown-linux-musl:Linux-aarch64) runs_here=1 ;;
  *) runs_here= ;;
esac
# Rosetta, which runs x86_64 programs in a container on an Apple silicon Mac, cannot
# start a process whose address space is limited to the reader's default (RLIMIT_AS,
# which the reader sets on Linux), and says so: that run proves nothing about the
# program. verify.sh runs it with a larger limit (MARFA_VERIFY_MEMORY).
if [ -n "$runs_here" ]; then
  shipped_said=$("$shipped" read "$fault_file" 2>&1) && shipped_ok=1 || shipped_ok=
  case "$shipped_said" in
    *"rosetta error"*) echo "program: Rosetta cannot run the reader's address-space limit; not run here" ;;
    *)
      [ -n "$shipped_ok" ] || die "the shipped program refused a plain text file that names a fault: $shipped_said"
      if "$proof" read "$fault_file" >/dev/null 2>&1; then
        die "the proof program ignored a fault, so it proves nothing"
      fi
      ;;
  esac
fi
rm -f "$fault_file"

for program in "$shipped" "$proof" "$OUT/marfa-enrichment-fuzz"; do
  check_program "$program"
done

for program in "$shipped" "$proof" "$OUT/marfa-enrichment-fuzz"; do
  echo "program: $(wc -c <"$program") bytes $program"
done
( cd "$OUT" && { sha256sum marfa-enrichment-read marfa-enrichment-read-proof marfa-enrichment-fuzz 2>/dev/null \
    || shasum -a 256 marfa-enrichment-read marfa-enrichment-read-proof marfa-enrichment-fuzz; } >SHA256SUMS )
