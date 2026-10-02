#!/usr/bin/env bash
# Fails if the login keychain's entries under the service marfa, or the
# keychain search list, changed while the command ran. An entry written and
# removed within the run is not seen.
#
#   core/scripts/login-keychain-unchanged.sh cargo nextest run --workspace
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# Proves the listing still parses the dump, so an unchanged comparison is
# never two empty listings. Not named `login`, which macOS would add to the
# search list.
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
