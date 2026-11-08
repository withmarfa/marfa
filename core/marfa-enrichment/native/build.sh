#!/bin/bash
# Builds everything the `native` feature links, for one target, into
# $MARFA_NATIVE_ROOT/prefix/<target>/ (lib/, include/, tessdata/). Unattended: it
# fetches, verifies each download against native/manifest.txt, and stops at the
# first mismatch.
#
#   MARFA_NATIVE_ROOT=<folder> native/build.sh <target>
#   MARFA_NATIVE_PREFIX=<folder>/prefix/<target> cargo build --features native
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
dir=$(dirname "${BASH_SOURCE[0]}")
"$dir/models.sh" "$TARGET"
"$dir/tesseract.sh" "$TARGET"
"$dir/pdfium.sh" "$TARGET"
