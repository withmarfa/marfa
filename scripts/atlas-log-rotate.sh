#!/usr/bin/env bash
set -euo pipefail

# Atlas-side log rotator for myme-staging + myme-conformance.
# Invoked hourly by ~/Library/LaunchAgents/so.myme.log-rotator.plist.
#
# Approach: inode-preserving truncate. launchd opens StandardOutPath /
# StandardErrorPath with O_APPEND, so writes resume cleanly after the
# file is truncated to zero. No service restart needed; no fd orphaning.
#
# Threshold: rotate when file >= 10 MB. Keep 7 most-recent archives.

ROTATE_MB_THRESHOLD=10
MAX_ARCHIVES=7

rotate_log() {
  local logfile="$1"
  [[ -f "$logfile" ]] || return 0

  local size_bytes
  size_bytes=$(stat -f%z "$logfile")
  local size_mb=$(( size_bytes / 1024 / 1024 ))
  if (( size_mb < ROTATE_MB_THRESHOLD )); then
    return 0
  fi

  local archive
  archive="${logfile}.$(date -u +%Y%m%dT%H%M%SZ).gz"
  gzip -c "$logfile" > "$archive"
  : > "$logfile"

  # Prune old archives — keep MAX_ARCHIVES most recent per log.
  # shellcheck disable=SC2012
  ls -t "${logfile}".*.gz 2>/dev/null | tail -n +$((MAX_ARCHIVES + 1)) | xargs -I{} rm -f {}
}

for log in \
  "$HOME/Services/myme-staging/logs/stdout.log" \
  "$HOME/Services/myme-staging/logs/stderr.log" \
  "$HOME/Services/myme-conformance/logs/stdout.log" \
  "$HOME/Services/myme-conformance/logs/stderr.log"; do
  rotate_log "$log"
done
