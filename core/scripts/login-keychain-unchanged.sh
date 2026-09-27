#!/usr/bin/env bash
# Runs a command and fails if the login keychain's entries under the
# binary's service, or the keychain search list, changed while it ran: the
# tests keep in keychain files of their own, and the login keychain is the
# person's. An entry written and taken out again within the run is not
# seen; the tests' own assertions are what hold that.
#
#   core/scripts/login-keychain-unchanged.sh cargo nextest run --workspace
#
# The comparison is made whether the command passed or not, since a failing
# run is as able to leave an entry behind, and the command's own status is
# the answer when nothing changed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# The witness: the listing finds the one entry a keychain made for it holds,
# so an unchanged comparison is never two empty listings of a dump the
# parser no longer reads. Named anything but `login`, which macOS would add
# to the person's search list.
witness="$(mktemp -d)"
trap 'security delete-keychain "${witness}/witness.keychain-db" 2>/dev/null || true; rm -rf "${witness}"' EXIT
security create-keychain -p witness "${witness}/witness.keychain-db"
security add-generic-password -s marfa -a witness -w witness "${witness}/witness.keychain-db"
if [[ "$("${here}/login-keychain.sh" marfa "${witness}/witness.keychain-db" | wc -l | tr -d ' ')" != 1 ]]; then
  echo "::error::login-keychain.sh does not find an entry it was shown." >&2
  exit 1
fi

searched="$(security list-keychains -d user)"
before="$("${here}/login-keychain.sh" marfa)"
status=0
"$@" || status=$?
after="$("${here}/login-keychain.sh" marfa)"
if [[ "${before}" != "${after}" ]]; then
  echo "::error::The run changed the login keychain under the service marfa." >&2
  diff <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") >&2 || true
  exit 1
fi
if [[ "${searched}" != "$(security list-keychains -d user)" ]]; then
  echo "::error::The run changed the keychain search list." >&2
  exit 1
fi
exit "${status}"
