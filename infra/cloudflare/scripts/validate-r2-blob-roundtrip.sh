#!/usr/bin/env bash
#
# Validate the R2 S3-API credential against a Marfa blobs bucket with a real
# PUT -> GET -> verify -> DELETE round-trip, BEFORE switching the server to
# BLOB_BACKEND=s3. Mirrors the server's S3 client exactly (S3BlobBackend):
# path-style addressing, region "auto", the standard-jurisdiction endpoint, and
# the "blobs/" key prefix. A green run proves the credential can read+write the
# bucket the container will use, so the cutover deploy won't 500 on first upload.
#
# Usage:
#   ./infra/cloudflare/scripts/validate-r2-blob-roundtrip.sh [staging|prod]
#
# Reads the credential from the calling shell (source your per-machine secrets
# file first). The secret is never printed.
#   R2_ACCESS_KEY_ID      <- S3 Access Key ID
#   R2_SECRET_ACCESS_KEY  <- S3 Secret Access Key  (never echoed)
#   CLOUDFLARE_ACCOUNT_ID <- marfa account id (derives the S3 endpoint)
# Optional:
#   S3_ENDPOINT           <- override the derived standard endpoint
#
# Requires the aws CLI (v2). The test object is written under a dedicated
# "_validation/" key (NOT the live "blobs/" prefix) so a stray failure can never
# collide with a real content-addressed blob, and is deleted on success.

set -euo pipefail

ENV_NAME="${1:-staging}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 [staging|prod]" >&2
  exit 1
fi
BUCKET="marfa-blobs-${ENV_NAME}"

: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID (source your secrets file)}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY (never printed)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

command -v aws >/dev/null 2>&1 || { echo "error: aws CLI not found" >&2; exit 1; }

ENDPOINT="${S3_ENDPOINT:-https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com}"
KEY="_validation/roundtrip-$(date +%s)-$$.txt"
PAYLOAD="marfa r2 blob durability check $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Match the server's S3 client: explicit creds, region "auto", path-style.
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
AWS=(aws s3api --endpoint-url "$ENDPOINT")

TMP_IN="$(mktemp)"; TMP_OUT="$(mktemp)"
printf '%s' "$PAYLOAD" > "$TMP_IN"
cleanup() {
  rm -f "$TMP_IN" "$TMP_OUT"
  # Best-effort delete in case we exit between PUT and the explicit delete.
  "${AWS[@]}" delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ Bucket:   $BUCKET"
echo "→ Endpoint: $ENDPOINT"
echo "→ Region:   auto (path-style)"
echo "→ Test key: $KEY"
echo ""

echo "→ PUT"
"${AWS[@]}" put-object --bucket "$BUCKET" --key "$KEY" \
  --body "$TMP_IN" --content-type "text/plain" >/dev/null
echo "  ✓ put"

echo "→ GET"
"${AWS[@]}" get-object --bucket "$BUCKET" --key "$KEY" "$TMP_OUT" >/dev/null
echo "  ✓ get"

echo "→ Verify content"
if [[ "$(cat "$TMP_OUT")" != "$PAYLOAD" ]]; then
  echo "  ✗ content mismatch — round-trip corrupted the object" >&2
  exit 1
fi
echo "  ✓ byte-identical"

echo "→ DELETE"
"${AWS[@]}" delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null
echo "  ✓ deleted"

echo ""
echo "✅ R2 S3-API round-trip OK against $BUCKET — credential can read+write."
echo "   Safe to deploy this env with V_BLOB_BACKEND=s3."
