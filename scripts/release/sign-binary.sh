#!/usr/bin/env bash
# Sign a macOS binary with the maintainer's Developer ID, under the hardened
# runtime, and have Apple notarize it. A browser marks what it downloads, and
# macOS refuses to run a marked program that Apple has not notarized. `curl`
# and `gh` mark nothing, so only a browser download shows whether this worked.
#
# A bare binary cannot carry its notarization ticket, so nothing is stapled:
# macOS looks the ticket up online the first time a marked copy runs.
#
# The identity comes in as a base64 PKCS#12 and is imported into a keychain
# of the run's own, deleted on exit, so the runner's login keychain is never
# touched.
#
#   sign-binary.sh <binary>
#
# Reads APPLE_DEVELOPER_ID_P12, APPLE_DEVELOPER_ID_P12_PASSWORD,
# APPLE_NOTARY_KEY, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID and
# APPLE_TEAM_ID from the environment.
set -euo pipefail

binary="$1"

missing=()
for name in APPLE_DEVELOPER_ID_P12 APPLE_DEVELOPER_ID_P12_PASSWORD APPLE_NOTARY_KEY \
  APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID APPLE_TEAM_ID; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Signing needs ${missing[*]}, which the environment does not set."
  exit 1
fi
if [ ! -f "$binary" ]; then
  echo "::error::$binary is not a file."
  exit 1
fi

work=$(mktemp -d)
keychain="$work/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

(
  umask 077
  printf '%s' "$APPLE_DEVELOPER_ID_P12" | base64 --decode >"$work/identity.p12"
  printf '%s\n' "$APPLE_NOTARY_KEY" >"$work/notary.p8"
)

keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" \
  -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null

codesign --force --options runtime --timestamp --keychain "$keychain" \
  --sign "Developer ID Application" "$binary"
codesign --verify --strict "$binary"
details=$(codesign -dv "$binary" 2>&1)
if ! grep -qx "TeamIdentifier=$APPLE_TEAM_ID" <<<"$details" || ! grep -q "(runtime)" <<<"$details"; then
  echo "::error::$binary is not signed by team $APPLE_TEAM_ID under the hardened runtime:"
  echo "$details"
  exit 1
fi

# The notary service takes a ZIP, not a bare binary or a tarball.
ditto -c -k --keepParent "$binary" "$work/submission.zip"
xcrun notarytool submit "$work/submission.zip" \
  --key "$work/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" \
  --wait --timeout 30m --output-format json >"$work/result.json"
status=$(plutil -extract status raw -o - "$work/result.json")
id=$(plutil -extract id raw -o - "$work/result.json")
if [ "$status" != "Accepted" ]; then
  echo "::error::Apple did not notarize $binary: $status (submission $id)."
  xcrun notarytool log "$id" \
    --key "$work/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" || true
  exit 1
fi
echo "$(basename "$binary") is signed by team $APPLE_TEAM_ID and notarized (submission $id)."
