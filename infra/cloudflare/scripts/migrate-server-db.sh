#!/usr/bin/env bash
#
# Apply pending Drizzle migrations to the hosted server's Neon Postgres
# database for a target environment, BEFORE the container rolls.
#
# Canonical ordering is migrate-then-deploy: schema lands first, then the new
# image boots against an already-migrated database. The server does NOT migrate
# on boot, so without this step a schema-bearing image crash-loops against the
# old schema (Cloudflare Containers surfaces it as a generic "Failed to start
# container" 500 that masks the schema mismatch). Running migrations here makes
# schema and code land together.
#
# Migrate-then-deploy is safe for additive / backward-compatible migrations —
# the overwhelming majority. The one ordering caveat: a migration that TIGHTENS
# a constraint (e.g. a new UNIQUE index) must not pre-date the code that keeps
# the data satisfying it. Such a migration has to ship in a later deploy than
# the code change that stops violating rows from being written — split it into
# two deploys (code first, constraint second) rather than relying on this
# step's ordering. This script does not and cannot detect that; it is a
# per-migration authoring discipline (see the deploy docs).
#
# Usage:
#   ./infra/cloudflare/scripts/migrate-server-db.sh <staging|prod>
#
# DB URL resolution is per-env, with a backward-compat fallback to the legacy
# shared *_MARFA names so existing operator shells keep working:
#
#   staging  direct  <- NEON_DATABASE_URL_STAGING         || NEON_DATABASE_URL_MARFA
#   prod     direct  <- NEON_DATABASE_URL_PROD
#
# The migrate step uses the DIRECT (unpooled) URL — Drizzle's migrator opens a
# single dedicated connection and runs DDL; the pooled endpoint (PgBouncer in
# transaction mode) doesn't support the session-level statements DDL relies on.
# The app itself uses the POOLED URL (set as the DATABASE_URL Worker secret by
# init-server-container-secrets.sh).
#
# Fails loud (non-zero exit) if no URL resolves or if the migration itself
# fails — the caller (deploy script / CI workflow) MUST treat a non-zero exit
# as a hard stop and never roll the container against an unmigrated DB.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod>" >&2
  exit 1
fi

# Resolve the DIRECT (unpooled) Neon URL for the target env, preferring the
# per-env name and falling back to the legacy shared *_MARFA name (staging only;
# prod was always split onto its own branch).
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

echo "→ Migrating $ENV_NAME database (direct URL) before container rollout"
# Never echo the URL — it carries credentials. Surface the host only.
DB_HOST="$(printf '%s' "$DIRECT_URL" | sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#')"
echo "  host: ${DB_HOST:-<unparsed>}"

cd "$REPO_ROOT"
DB_DIALECT=pg DATABASE_URL="$DIRECT_URL" \
  pnpm --filter @withmarfa/server run migrate

echo "✓ Migrations applied for $ENV_NAME"
