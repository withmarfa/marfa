#!/bin/sh
# The container's one process tree: Litestream in front, the server behind
# it. With no database on the volume the last replica under the instance's
# own `S3_PREFIX` is restored first, so a fresh volume boots the instance it
# replaces rather than an empty one, and never another instance that shares
# the bucket under another prefix. A database that was already on the volume
# is first checked against that replica, and replication does not start when
# the database may be older: Litestream would make it the replica's newest
# state, and the writes after it would remain only in the replica's
# history, which expires. Then the server runs under `litestream replicate
# -exec`, which streams every committed page to the bucket and stops the
# server when it is itself stopped.
#
# Without `S3_BUCKET` there is nothing to stream to, and the server runs on
# its own; that is a local or trial container, never a deployment, and the
# line below says so in the log.
#
# A server that stops because it refuses the database on the volume, one a
# newer build wrote, one it cannot update or one whose update failed and was
# rolled back, has not crashed: starting it again meets the same file. It
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
# The value with the space around it removed, as the server reads a setting.
trimmed() {
  t=$1
  while :; do case $t in [[:space:]]*) t=${t#?} ;; *) break ;; esac; done
  while :; do case $t in *[[:space:]]) t=${t%?} ;; *) break ;; esac; done
  printf '%s' "$t"
}
# The key prefix as the server reads it (`keyPrefix` in
# `packages/server/src/config.ts`), because Litestream takes the replica path,
# `<prefix>/db`, as written. The server is handed the same reading, and
# `ci/entrypoint.test.ts` holds the two together.
prefix=$(trimmed "${S3_PREFIX:-}")
[ -n "$prefix" ] || prefix=blobs
while :; do case $prefix in /*) prefix=${prefix#/} ;; *) break ;; esac; done
while :; do case $prefix in */) prefix=${prefix%/} ;; *) break ;; esac; done
case /$prefix/ in
  *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]* | *//* | */./* | */../*)
    echo "S3_PREFIX must be segments of letters, digits, \`.\`, \`_\` and \`-\` joined by \`/\`, none of them \`.\` or \`..\`, such as \`blobs\` or \`trial/blobs\`" >&2
    exit 1
    ;;
esac
S3_PREFIX=$prefix
export SQLITE_PATH BLOB_PATH S3_FORCE_PATH_STYLE S3_REGION S3_PREFIX

# The words the server reads as a flag, in any case and with any space
# around them, and empty for unset.
replace_newer=$(trimmed "${MARFA_REPLACE_NEWER_REPLICA:-}" | tr '[:upper:]' '[:lower:]')
case $replace_newer in
  true | 1 | yes | on) replace_newer=true ;;
  '' | false | 0 | no | off) replace_newer=false ;;
  *)
    echo "MARFA_REPLACE_NEWER_REPLICA must be true or false (also 1/0, yes/no, on/off)" >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$SQLITE_PATH")" "$BLOB_PATH"

# The status the server stops with when it refuses a database:
# `REFUSED_DATABASE_EXIT_CODE` in
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
  had_database=false
  if [ -e "$SQLITE_PATH" ]; then had_database=true; fi
  # `-if-db-not-exists` leaves a database already on the volume alone;
  # `-if-replica-exists` makes a prefix holding no replica yet, the first boot
  # of a new instance, a fresh start rather than a failure.
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$SQLITE_PATH"

  # A database the restore wrote is the replica's newest state. One that was
  # already here may be older. The check reads the volume and lists the
  # bucket, and writes to neither. A bucket it cannot list leaves the answer
  # unknown, and the start fails rather than risk the replica's newer writes:
  # a restart policy tries again, and the override starts without the bucket.
  #
  # Litestream's record beside the database names the transactions this
  # volume replicated, and Litestream continues the replica from it without
  # asking whether the record is of this replica or of this database. Unless
  # the check found that it continues this replica, it is removed, and
  # Litestream starts the replica from a snapshot of the database. Kept, a
  # record of a database the restore replaced, of another replica, or of an
  # empty replica's predecessor would have Litestream upload transactions
  # whose files the record does not hold, and every sync would fail.
  #
  # Transaction IDs count within one replica's history, so a file beside the
  # database names the replica the record is of, as `replicaMarker` in
  # `packages/server/src/storage/sqlite/replica-position.ts` reads it. It is
  # removed with the record and written once the record is settled, so the
  # two agree. The check takes a record with no such file, which a volume
  # replicated by an earlier image holds, to be of this replica. The file
  # holds one value a line, so the endpoint and bucket are written as the
  # server reads them, without the space around them.
  record="$(dirname "$SQLITE_PATH")/.$(basename "$SQLITE_PATH")-litestream"
  replica_marker="$SQLITE_PATH-replica"
  endpoint=$(trimmed "${S3_ENDPOINT:-}")
  bucket=$(trimmed "$S3_BUCKET")
  forget_record=false
  if [ "$had_database" = false ]; then
    forget_record=true
  elif [ "$replace_newer" = true ]; then
    echo "MARFA_REPLACE_NEWER_REPLICA is set, so the database at $SQLITE_PATH is replicated to $S3_PREFIX/db without checking that it is not older than the replica there: it becomes the replica's newest state. Unset MARFA_REPLACE_NEWER_REPLICA once this start has replicated." >&2
    forget_record=true
  else
    if ! replica=$(litestream ltx -config /etc/litestream.yml -level all -json "$SQLITE_PATH"); then
      echo "Could not list the replica at $S3_PREFIX/db in the bucket $S3_BUCKET, so this start cannot check that the database at $SQLITE_PATH is not older than it. Replication has not started, and the bucket is unchanged. Start again once the bucket can be reached. To start without the check, start once with MARFA_REPLACE_NEWER_REPLICA=true: a database older than the replica then becomes its newest state." >&2
      exit 1
    fi
    if ! verdict=$(printf '%s' "$replica" | node dist/replica-check.js "$SQLITE_PATH" "$bucket" "$S3_PREFIX" "$endpoint"); then
      exit 1
    fi
    if [ "$verdict" = empty ]; then forget_record=true; fi
  fi
  # The record goes before its marker: a start killed between the two finds
  # the old marker beside no record, or part of one, and refuses, where a
  # record left without its marker would be adopted as this replica's.
  if [ "$forget_record" = true ]; then
    if [ -e "$record" ]; then
      echo "Removing Litestream's record at $record, which describes replication that this start does not continue, so Litestream starts the replica at $S3_PREFIX/db from a snapshot of the database." >&2
      rm -rf "$record"
    fi
    rm -f "$replica_marker"
  fi
  printf 'endpoint=%s\nbucket=%s\nprefix=%s\n' "$endpoint" "$bucket" "$S3_PREFIX" > "$replica_marker.tmp"
  mv "$replica_marker.tmp" "$replica_marker"

  supervise litestream replicate -config /etc/litestream.yml -exec "/bin/sh \"$0\" run-server" || code=$?
fi

if [ -e "$MARFA_RUN_DIR/refused-database" ]; then
  echo "This server will not start on the database at $SQLITE_PATH, and the message above says why and what to do. This container stays up, unhealthy, so that nothing restarts it into the same refusal; stop it to remove it." >&2
  trap 'kill "$napping" 2>/dev/null || true; exit 0' TERM INT
  while :; do
    sleep 3600 &
    napping=$!
    wait "$napping"
  done
fi
exit "$code"
