#!/bin/bash
# The Linux build image, kept between runs. CI saves it from `main` and loads it
# everywhere, so that a run never builds it from the package archive again.
#
#   native/image.sh key            the hash of what decides the image
#   native/image.sh build          make the image unless it is loaded with that hash
#   native/image.sh save <file>    write the image to <file>, compressed
#   native/image.sh load <file>    load the image from <file>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# A failed `docker save` or `zstd` must fail the save, not leave a short file behind.
set -o pipefail

command=${1:-}
case "$command" in
  key) build_image_recipe ;;
  build)
    need docker
    make_build_image "$(build_image_name)"
    ;;
  save)
    need docker zstd
    [ -n "${2:-}" ] || die "usage: image.sh save <file>"
    mkdir -p "$(dirname "$2")"
    docker save "$(build_image_name)" | zstd -q -T0 -3 -f -o "$2" || die "could not save the image"
    ;;
  load)
    need docker zstd
    [ -f "${2:-}" ] || die "usage: image.sh load <file>"
    zstd -q -d -c "$2" | docker load >/dev/null || die "could not load the image"
    ;;
  *) die "usage: image.sh key | build | save <file> | load <file>" ;;
esac
