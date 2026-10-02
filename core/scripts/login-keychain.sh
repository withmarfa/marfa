#!/usr/bin/env bash
# Reads attributes only, never a secret, so it never raises a dialog.
#
#   core/scripts/login-keychain.sh marfa [KEYCHAIN]
set -euo pipefail

service="${1:?usage: login-keychain.sh SERVICE [KEYCHAIN]}"
dump="$(security dump-keychain "${2:-${HOME}/Library/Keychains/login.keychain-db}")"
awk -v service="\"${service}\"" '
  function flush() {
    if (class == "\"genp\"" && svce == service) print acct "\t" cdat "\t" mdat
    class = ""; svce = ""; acct = ""; cdat = ""; mdat = ""
  }
  /^keychain: / { flush() }
  /^class: / { class = $2 }
  /^ *"svce"<blob>=/ { sub(/^ *"svce"<blob>=/, ""); svce = $0 }
  /^ *"acct"<blob>=/ { sub(/^ *"acct"<blob>=/, ""); acct = $0 }
  /^ *"cdat"<timedate>=/ { cdat = $NF }
  /^ *"mdat"<timedate>=/ { mdat = $NF }
  END { flush() }
' <<<"${dump}" | sort
