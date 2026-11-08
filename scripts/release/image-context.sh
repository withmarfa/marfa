#!/usr/bin/env bash
# Lay out the build context of `deploy/Dockerfile` from the release's own Linux
# archives, so the image holds the bytes a person downloads: `amd64/` from the
# x86_64 archive and `arm64/` from the aarch64 one, each with `marfa`,
# `marfa-server` and `NOTICES.txt`.
#
#   image-context.sh <folder holding the archives> <version> <context folder>
set -euo pipefail

archives="$1"
version="$2"
context="$3"

mkdir -p "$context"
for pair in amd64:x86_64 arm64:aarch64; do
  architecture="${pair%%:*}"
  archive="$archives/marfa-$version-linux-${pair##*:}.tar.gz"
  if [ ! -s "$archive" ]; then
    echo "::error::$archive is missing or empty."
    exit 1
  fi
  mkdir "$context/$architecture"
  tar -xzf "$archive" -C "$context/$architecture"
  for name in marfa marfa-server NOTICES.txt; do
    if [ ! -s "$context/$architecture/$name" ]; then
      echo "::error::$(basename "$archive") holds no $name."
      exit 1
    fi
  done
done
find "$context" -type f | LC_ALL=C sort
