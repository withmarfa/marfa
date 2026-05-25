#!/usr/bin/env bash
#
# Build a Worker's workspace dependencies, then `wrangler deploy` it.
#
# Why this exists (T-251). `wrangler deploy` doesn't rebuild any
# workspace `dist/` artefacts before bundling — it just packages
# whatever's currently in `node_modules/`. After merging a workspace
# change (e.g. `@withmarfa/webhooks`), the next `wrangler deploy` of a
# consumer Worker carries the OLD bundled dist until someone manually
# runs `pnpm --filter <pkg> build`. Surfaced during T-247's
# runtime-control redeploy: a freshly-deployed Worker rejected the
# new `cloudflare-email` verification method with
# `unknown_verification_method:cloudflare-email` because the bundled
# `@withmarfa/webhooks` was pre-T-247. This script closes that gap by
# pre-building every workspace dep the target Worker transitively
# consumes (plus the Worker package itself, which is harmless and
# rebuilds `dist/local.js` for the local-runtime path).
#
# Usage:
#   ./scripts/deploy-worker.sh <worker-dir> [extra wrangler args...]
#
# Example:
#   CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_MYME \
#     ./scripts/deploy-worker.sh integrations/google-contacts --env staging
#
# Cloudflare account selection is the caller's job — set
# CLOUDFLARE_API_TOKEN (or use the existing `wrangler-marfa` helper
# wrapper from aic-shell which sets it from `CLOUDFLARE_API_TOKEN_MYME`
# / `_AIC`). The script invokes bare `wrangler`; it doesn't pick an
# account.

set -euo pipefail

WORKER_DIR="${1:-}"
if [[ -z "$WORKER_DIR" ]]; then
  echo "Usage: $0 <worker-dir> [wrangler-args...]" >&2
  echo "Example: $0 integrations/google-contacts --env staging" >&2
  exit 1
fi
shift

if [[ ! -f "$WORKER_DIR/package.json" ]]; then
  echo "Error: $WORKER_DIR/package.json not found." >&2
  exit 1
fi

PKG_NAME=$(node -p "require('./$WORKER_DIR/package.json').name")
if [[ -z "$PKG_NAME" || "$PKG_NAME" == "undefined" ]]; then
  echo "Error: could not read package name from $WORKER_DIR/package.json" >&2
  exit 1
fi

echo "→ Pre-building workspace deps for $PKG_NAME"
# `pnpm --filter "<pkg>..."` selects <pkg> + every workspace package
# it transitively DEPENDS ON (upstream). pnpm filter direction: the
# `...` AFTER the package name walks downwards in the dep graph
# (i.e. the things <pkg> imports). `...<pkg>` (the opposite — `...`
# before) selects <pkg>'s dependents, which is the wrong direction
# for pre-deploy.
# `--if-present` skips packages without a `build` script (e.g.
# runtime-control bundles via wrangler and has no `build`;
# integration Workers do have a `build` that emits `dist/local.js`
# for the local-runtime substrate path). pnpm honours topological
# order, so `@withmarfa/shared` rebuilds before `@withmarfa/webhooks`
# before consumer-packages — no stale upstream dist landing in the
# worker bundle.
pnpm --filter "$PKG_NAME..." --if-present build

# Working-dir handling: if the worker dir carries its own wrangler.toml
# / wrangler.jsonc, cd in so wrangler picks it up automatically. If
# not (e.g. `packages/runtime-control` whose deploy uses
# `infra/cloudflare/wrangler.control.toml`), stay at the repo root and
# let the caller pass `--config <path>` through the extra args.
if [[ -f "$WORKER_DIR/wrangler.toml" || -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  echo "→ wrangler deploy in $WORKER_DIR ($*)"
  cd "$WORKER_DIR"
else
  echo "→ wrangler deploy from repo root ($*)"
  echo "   $WORKER_DIR has no wrangler.toml/jsonc — pass --config via the extra args"
fi
exec wrangler deploy "$@"
