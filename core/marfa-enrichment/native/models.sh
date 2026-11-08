#!/bin/bash
# Fetches the models listed in the manifest, verifies each, and puts them in the
# target's prefix under tessdata/. They are the same for every target.
#
#   MARFA_NATIVE_ROOT=<folder> native/models.sh <target>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

select_target "${1:-}"
select_root
need curl

# Models the manifest no longer lists are removed, so what the prefix holds is
# exactly what the manifest says.
rm -f "$PREFIX"/tessdata/*.traineddata
count=0
while read -r kind language url sha; do
  [ "$kind" = model ] || continue
  download "$url" "$sha" "$DOWNLOADS/$language.traineddata"
  cp "$DOWNLOADS/$language.traineddata" "$PREFIX/tessdata/$language.traineddata"
  count=$((count + 1))
done <"$MANIFEST"
[ "$count" -gt 0 ] || die "the manifest lists no model"
echo "models: $count in $PREFIX/tessdata"
