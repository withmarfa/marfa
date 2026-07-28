#!/usr/bin/env bash
#
# Set the three secrets a per-integration Worker needs on first deploy.
# Without these the queue consumer's credential mint throws on
# `undefined/lease/...`; the failure surfaces via console.error in
# `wrangler tail`.
#
# Two of the three are read straight from the calling shell. The third,
# MARFA_WORKER_IDENTITY_KEY, is DERIVED here rather than supplied: it is
# `HMAC-SHA256(MARFA_WORKER_IDENTITY_SECRET, <integration name>)`, the
# same computation the control plane performs when it authenticates this
# Worker and when it dispatches into it. Deriving means the operator
# holds one root secret rather than one secret per Worker, and a new
# integration needs no new secret to be invented.
#
# The Worker deliberately does NOT receive MARFA_RUNTIME_BROKER_KEY. That
# key carries `is_platform: true` and can mint a runtime credential for
# any Connection in any tenant; a copy on each of the deployed Workers
# made every one of them a platform principal. It stays between the Marfa
# server and the control plane.
#
# The integration name is read from the Worker's own wrangler.toml
# (`INTEGRATION_NAME` under `[vars]`) rather than passed in, because the
# name the Worker announces itself as at runtime is the only one the
# control plane will accept. Taking it from anywhere else lets a typo
# produce a key that authenticates nothing, and the symptom is a 401 on
# every lease.
#
# Usage:
#   ./init-integration-worker-secrets.sh <integration-dir> <env>
# Example:
#   ./init-integration-worker-secrets.sh integrations/google-contacts staging
#
# Required environment:
#   MARFA_API_URL                 e.g. https://staging.marfa.so
#   MARFA_RUNTIME_CONTROL_URL     e.g. https://runtime-staging.marfa.so
#   MARFA_WORKER_IDENTITY_SECRET  the control plane's per-Worker identity
#                                 root, the same value set on the
#                                 runtime-control Worker for this env.
#                                 Per-env: a staging root must not be a
#                                 production root, or a staging Worker
#                                 authenticates against production.
#   CLOUDFLARE_API_TOKEN          Cloudflare token with Workers write on
#                                 the target account; same token
#                                 `wrangler` uses elsewhere. Source from
#                                 your normal secrets file.
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
for var in MARFA_API_URL MARFA_RUNTIME_CONTROL_URL MARFA_WORKER_IDENTITY_SECRET CLOUDFLARE_API_TOKEN; do
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

# First INTEGRATION_NAME in the config is the top-level [vars] entry; the
# per-env blocks repeat the same value, so any of them would do.
INTEGRATION_NAME="$(sed -n 's/^INTEGRATION_NAME[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$INTEGRATION_DIR/wrangler.toml" | head -n1)"
if [[ -z "$INTEGRATION_NAME" ]]; then
  echo "Error: no INTEGRATION_NAME found in $INTEGRATION_DIR/wrangler.toml." >&2
  echo "The Worker announces itself to the control plane under that name," >&2
  echo "so its identity key cannot be derived without it." >&2
  exit 1
fi

# `printf %s` rather than `echo`, which appends a newline that would be
# hashed and produce a key the control plane never computes.
MARFA_WORKER_IDENTITY_KEY="$(printf '%s' "$INTEGRATION_NAME" \
  | openssl dgst -sha256 -hmac "$MARFA_WORKER_IDENTITY_SECRET" -hex \
  | sed 's/^.*= //')"
if [[ ! "$MARFA_WORKER_IDENTITY_KEY" =~ ^[0-9a-f]{64}$ ]]; then
  # Anything else means openssl changed its output shape or failed
  # silently, and writing a malformed secret would fail at the first
  # lease with nothing pointing back here.
  echo "Error: derived identity key is not 64 hex characters." >&2
  exit 1
fi

echo "→ Setting 3 secrets on $INTEGRATION_DIR (env=$ENV_NAME, integration=$INTEGRATION_NAME)"
cd "$INTEGRATION_DIR"

for var in MARFA_API_URL MARFA_RUNTIME_CONTROL_URL MARFA_WORKER_IDENTITY_KEY; do
  echo "  - $var"
  printf '%s' "${!var}" | wrangler secret put "$var" --env "$ENV_NAME" >/dev/null
done

echo "✓ Done. Verify with: cd $INTEGRATION_DIR && wrangler secret list --env $ENV_NAME"
echo ""
echo "If this Worker still carries MARFA_RUNTIME_BROKER_KEY from an earlier"
echo "deploy, remove it — it is a platform credential and nothing here uses it:"
echo "  cd $INTEGRATION_DIR && wrangler secret delete MARFA_RUNTIME_BROKER_KEY --env $ENV_NAME"
