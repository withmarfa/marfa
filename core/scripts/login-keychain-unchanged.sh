#!/usr/bin/env bash
# Runs a command and fails if the login keychain's entries under the
# binary's service changed while it ran: the tests keep in keychain files
# of their own, and the login keychain is the person's.
#
#   core/scripts/login-keychain-unchanged.sh cargo test --workspace
#
# The comparison is made whether the command passed or not, since a failing
# run is as able to leave an entry behind, and the command's own status is
# the answer when nothing changed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
before="$("${here}/login-keychain.sh" marfa)"
status=0
"$@" || status=$?
after="$("${here}/login-keychain.sh" marfa)"
if [[ "${before}" != "${after}" ]]; then
  echo "::error::The run changed the login keychain under the service marfa." >&2
  diff <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") >&2 || true
  exit 1
fi
exit "${status}"
