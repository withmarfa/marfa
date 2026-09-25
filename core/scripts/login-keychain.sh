#!/usr/bin/env bash
# Lists the login keychain's generic passwords under one service, or those
# of the keychain file named after it, one line each: account, creation and
# modification time. Read from the items'
# attributes alone, never a secret, so listing never asks a person for
# anything.
#
#   core/scripts/login-keychain.sh marfa [KEYCHAIN]
#
# login-keychain-unchanged.sh compares two listings around a run.
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
