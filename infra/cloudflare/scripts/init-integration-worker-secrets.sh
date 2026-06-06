#!/usr/bin/env bash
#
# Set the three broker / API secrets a per-integration Worker needs on
# first deploy. Without these the queue consumer's credential mint
# throws on `undefined/lease/...`; the failure surfaces via
# console.error in `wrangler tail`.
#
# Reads the three values from the calling shell's environment and runs
# `wrangler secret put` for each against the target Worker + env. The
# operator is responsible for ensuring the three vars are exported
# (typically from a per-machine secrets file outside the repo) before
# invoking this script.
#
# Usage:
#   ./init-integration-worker-secrets.sh <integration-dir> <env>
# Example:
#   ./init-integration-worker-secrets.sh integrations/google-contacts staging
#
# Required environment:
#   MARFA_API_URL              e.g. https://staging.marfa.so
#   MARFA_RUNTIME_CONTROL_URL  e.g. https://runtime-staging.marfa.so
#   MARFA_RUNTIME_BROKER_KEY   the broker key from the server's
#                             `MARFA_RUNTIME_BROKER_KEY` env (same value
#                             — the integration Worker presents it when
#                             calling the broker to mint per-Connection
#                             runtime credentials).
#   CLOUDFLARE_API_TOKEN      Cloudflare token with Workers write on
#                             the target account; same token `wrangler`
#                             uses elsewhere. Source from your normal
#                             secrets file.
#
# Idempotent: re-running overwrites the secrets in place. Use
# `wrangler secret delete` separately to remove.
set -euo pipefail

INTEGRATION_DIR="${1:-}"
ENV_NAME="${2:-}"

if [[ -z "$INTEGRATION_DIR" || -z "$ENV_NAME" ]]; then
  echo "Usage: $0 <integration-dir> <env>"
  echo "Example: $0 integrations/google-contacts staging"
  exit 1
fi

if [[ ! -f "$INTEGRATION_DIR/wrangler.toml" ]]; then
  echo "Error: $INTEGRATION_DIR/wrangler.toml not found." >&2
  echo "Run this script from the repo root with a path to an integration directory." >&2
  exit 1
fi

missing=()
for var in MARFA_API_URL MARFA_RUNTIME_CONTROL_URL MARFA_RUNTIME_BROKER_KEY CLOUDFLARE_API_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: missing required environment variables:" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  echo "" >&2
  echo "Export them (e.g. from your per-machine secrets file)" >&2
  echo "before invoking this script." >&2
  exit 1
fi

echo "→ Setting 3 broker / API secrets on $INTEGRATION_DIR (env=$ENV_NAME)"
cd "$INTEGRATION_DIR"

for var in MARFA_API_URL MARFA_RUNTIME_CONTROL_URL MARFA_RUNTIME_BROKER_KEY; do
  echo "  - $var"
  echo "${!var}" | wrangler secret put "$var" --env "$ENV_NAME" >/dev/null
done

echo "✓ Done. Verify with: cd $INTEGRATION_DIR && wrangler secret list --env $ENV_NAME"
