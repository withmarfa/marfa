#!/usr/bin/env bash
#
# Seed the fixed first-party OAuth clients (marfa-web, marfa-tickets) into the
# target env's database, AFTER migrations.
#
# The hosted browser apps use a stable `client_id` rather than per-browser
# dynamic client registration (DCR). A DCR client lives only in the database,
# so a DB reset orphans every browser's cached client and sign-in then fails
# with `invalid_client`. Seeding the fixed rows on every deploy means a DB
# reset self-heals on the next rollout. Idempotent — an existing client is
# skipped, so re-running is safe.
#
# Usage:
#   ./infra/cloudflare/scripts/seed-server-oauth-clients.sh <staging|prod>
#
# Uses the same DIRECT (unpooled) Neon URL resolution as migrate-server-db.sh —
# the seed opens a single connection and runs reads + an insert, which the
# pooled (transaction-mode) endpoint can't support.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod>" >&2
  exit 1
fi

if [[ "$ENV_NAME" == "staging" ]]; then
  DIRECT_URL="${NEON_DATABASE_URL_STAGING:-${NEON_DATABASE_URL_MARFA:-}}"
else
  DIRECT_URL="${NEON_DATABASE_URL_PROD:-}"
fi

if [[ -z "$DIRECT_URL" ]]; then
  echo "error: no direct Neon URL resolved for $ENV_NAME" >&2
  if [[ "$ENV_NAME" == "staging" ]]; then
    echo "  set NEON_DATABASE_URL_STAGING (or legacy NEON_DATABASE_URL_MARFA)" >&2
  else
    echo "  set NEON_DATABASE_URL_PROD" >&2
  fi
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "→ Seeding first-party OAuth clients for $ENV_NAME (direct URL)"
DB_HOST="$(printf '%s' "$DIRECT_URL" | sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#')"
echo "  host: ${DB_HOST:-<unparsed>}"

cd "$REPO_ROOT"

# The seed runs the TypeScript source via tsx, but it imports @withmarfa/shared
# at runtime (the OAuth scope registry). CI's migrate job runs `pnpm install`
# with no build step, so build the server's workspace dependencies first —
# otherwise the import resolves to a non-existent dist. Near-instant when they
# are already built (local deploys).
pnpm --filter "@withmarfa/server^..." run build

DB_DIALECT=pg DATABASE_URL="$DIRECT_URL" \
  pnpm --filter @withmarfa/server exec tsx scripts/seed-oauth-clients.ts

echo "✓ OAuth clients seeded for $ENV_NAME"
