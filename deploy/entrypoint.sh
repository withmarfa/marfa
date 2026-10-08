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
#
# A server that stops because the database on the volume was written by
# another build has not crashed: starting it again meets the same file. It
# says so with its own exit status, which this script writes down, and the
# container then stays up, and unhealthy, with the server's message in the
# log, so that no restart policy turns the refusal into a loop, with a bucket
# or without one. A stop for any other reason ends the
# container with the server's status, and a supervisor may start it again.
set -eu

# Recovery uses the same production control router when public HTTP is unavailable.
if [ "${1:-}" = control-only ]; then
  export MARFA_CONTROL_ONLY=true
  exec node --import ./dist/instrumentation.js dist/index.js
fi

: "${SQLITE_PATH:=/data/marfa.db}"
: "${BLOB_PATH:=/data/blobs}"
# The sidecar's file needs a word where the server takes a default: path
# style with an endpoint, which is every S3-compatible store, and virtual
# hosting without one, which is AWS; the region the server assumes when
# none is named.
if [ -z "${S3_FORCE_PATH_STYLE:-}" ]; then
  if [ -n "${S3_ENDPOINT:-}" ]; then S3_FORCE_PATH_STYLE=true; else S3_FORCE_PATH_STYLE=false; fi
fi
: "${S3_REGION:=us-east-1}"
export SQLITE_PATH BLOB_PATH S3_FORCE_PATH_STYLE S3_REGION

mkdir -p "$(dirname "$SQLITE_PATH")" "$BLOB_PATH"

# The status the server stops with when it refuses a database another build
# wrote: `REFUSED_DATABASE_EXIT_CODE` in
# `packages/server/src/storage/sqlite/refused-database.ts`.
REFUSED_DATABASE=78

# Runs the command as a child of this shell, so its status can be read, and
# hands it the signals that stop the container.
supervise() {
  signalled=0
  "$@" &
  child=$!
  trap 'signalled=1; kill -TERM "$child" 2>/dev/null || true' TERM INT
  status=0
  wait "$child" || status=$?
  # A signal ends the wait at once, reporting 128 and the signal's number for
  # itself and not the child's status, whether the child has ended or not.
  # The child stays in the shell's table until it is waited for, so the
  # second wait answers its own status either way.
  if [ "$signalled" = 1 ]; then
    status=0
    wait "$child" || status=$?
  fi
  trap - TERM INT
  return "$status"
}

# The server itself, as `litestream replicate -exec` runs it. Litestream ends
# with status 1 whatever status its child ended with, so the refusal cannot
# travel back as an exit status: it is written down where the entrypoint that
# started this one looks, and the server's own status is passed on as it was.
if [ "${1:-}" = run-server ]; then
  code=0
  supervise node --import ./dist/instrumentation.js dist/index.js || code=$?
  if [ "$code" -eq "$REFUSED_DATABASE" ]; then : > "$MARFA_RUN_DIR/refused-database"; fi
  exit "$code"
fi

MARFA_RUN_DIR=$(mktemp -d)
export MARFA_RUN_DIR
code=0
if [ -z "${S3_BUCKET:-}" ]; then
  echo "S3_BUCKET is not set: the database is not streamed off-site and no object store is attached" >&2
  supervise /bin/sh "$0" run-server || code=$?
else
  # `-if-db-not-exists` leaves a database already on the volume alone;
  # `-if-replica-exists` makes a bucket holding no replica yet, the first boot
  # of a new instance, a fresh start rather than a failure.
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$SQLITE_PATH"

  supervise litestream replicate -config /etc/litestream.yml -exec "/bin/sh \"$0\" run-server" || code=$?
fi

if [ -e "$MARFA_RUN_DIR/refused-database" ]; then
  echo "The database at $SQLITE_PATH was written by another build, so this server will not start on it, and the message above says how to carry its data forward. This container stays up, unhealthy, so that nothing restarts it into the same refusal; stop it to remove it." >&2
  trap 'kill "$napping" 2>/dev/null || true; exit 0' TERM INT
  while :; do
    sleep 3600 &
    napping=$!
    wait "$napping"
  done
fi
exit "$code"
