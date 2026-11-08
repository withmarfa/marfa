#!/bin/bash
# Builds the server for a target from a finished prefix, with the native readers linked in, as
# $MARFA_NATIVE_ROOT/out/<target>/marfa-server.
#
#   MARFA_NATIVE_ROOT=<folder> native/server.sh <target>
#
# MARFA_SERVER_FEATURES names cargo features to add to `native`, such as `test-hooks` for the
# server the contract fixtures judge. A server that ships is built without any.
#
# Needs what program.sh needs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need cargo rustc

OUT="$ROOT/out/$TARGET"
mkdir -p "$OUT"
rm -f "$OUT/marfa-server"

CORE=$(cd "$NATIVE_DIR/../.." && pwd)
cargo_environment

(cd "$CORE" && cargo build --release --locked --target "$TARGET" -p marfa-server --features "native${MARFA_SERVER_FEATURES:+,$MARFA_SERVER_FEATURES}")
cp "$CARGO_TARGET_DIR/$TARGET/release/marfa-server" "$OUT/marfa-server"
echo "server: $(wc -c <"$OUT/marfa-server") bytes $OUT/marfa-server"
