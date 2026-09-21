#!/bin/sh
# The container's one process tree: Litestream in front, the server behind
# it. With no database on the volume the last replica in the bucket is
# restored first, so a fresh volume boots the instance it replaces rather
# than an empty one; then the server runs under `litestream replicate
# -exec`, which streams every committed page to the bucket and stops the
# server when it is itself stopped.
#
# Without `S3_BUCKET` there is nothing to stream to, and the server runs on
# its own; that is a local or trial container, never a deployment, and the
# line below says so in the log.
set -eu

: "${SQLITE_PATH:=/data/marfa.db}"
: "${BLOB_PATH:=/data/blobs}"
# The server reads an unset value as `true`; the sidecar's file needs a
# word, and the same one.
: "${S3_FORCE_PATH_STYLE:=true}"
export SQLITE_PATH BLOB_PATH S3_FORCE_PATH_STYLE

mkdir -p "$(dirname "$SQLITE_PATH")" "$BLOB_PATH"

if [ -z "${S3_BUCKET:-}" ]; then
  echo "S3_BUCKET is not set: the database is not streamed off-site and no object store is attached" >&2
  exec node --import ./dist/instrumentation.js dist/index.js
fi

# `-if-db-not-exists` leaves a database already on the volume alone;
# `-if-replica-exists` makes a bucket holding no replica yet, the first boot
# of a new instance, a fresh start rather than a failure.
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$SQLITE_PATH"

exec litestream replicate -config /etc/litestream.yml -exec "node --import ./dist/instrumentation.js dist/index.js"
