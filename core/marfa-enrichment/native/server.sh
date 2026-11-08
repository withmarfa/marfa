#!/bin/bash
# Builds the server for a target from a finished prefix, with the native readers linked in, as
# $MARFA_NATIVE_ROOT/out/<target>/marfa-server.
#
#   MARFA_NATIVE_ROOT=<folder> native/server.sh <target>
#
# Needs what program.sh needs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need cargo rustc

OUT="$ROOT/out/$TARGET"
mkdir -p "$OUT"
rm -f "$OUT/marfa-server"

source "$(dirname "${BASH_SOURCE[0]}")/program-env.sh"

(cd "$CORE" && cargo build --release --locked --target "$TARGET" -p marfa-server --features native)
cp "$CARGO_TARGET_DIR/$TARGET/release/marfa-server" "$OUT/marfa-server"
echo "server: $(wc -c <"$OUT/marfa-server") bytes $OUT/marfa-server"
