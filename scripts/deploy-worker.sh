#!/usr/bin/env bash
#
# Build a Worker's workspace dependencies, then `wrangler deploy` it.
#
# Why this exists. `wrangler deploy` doesn't rebuild any workspace
# `dist/` artifacts before bundling — it just packages whatever's
# currently in `node_modules/`. After merging a workspace change
# (e.g. `@withmarfa/webhooks`), the next `wrangler deploy` of a
# consumer Worker carries the OLD bundled dist until someone manually
# runs `pnpm --filter <pkg> build`. A freshly-deployed Worker that
# bundles a stale upstream can silently reject valid inputs at runtime.
# This script closes that gap by pre-building every workspace dep the
# target Worker transitively consumes (plus the Worker package itself,
# which is harmless and rebuilds `dist/local.js` for the local-runtime
# path).
#
# Usage:
#   ./scripts/deploy-worker.sh <worker-dir> [extra wrangler args...]
#
# Example:
#   CLOUDFLARE_API_TOKEN=<your-token> \
#     ./scripts/deploy-worker.sh integrations/withmarfa-inbox/email-worker --env staging
#
# Cloudflare account selection is the caller's job — set
# CLOUDFLARE_API_TOKEN in the environment before invoking. The script
# invokes bare `wrangler`; it doesn't pick an account.

set -euo pipefail

WORKER_DIR="${1:-}"
if [[ -z "$WORKER_DIR" ]]; then
  echo "Usage: $0 <worker-dir> [wrangler-args...]" >&2
  echo "Example: $0 integrations/withmarfa-inbox/email-worker --env staging" >&2
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
# `--if-present` skips packages without a `build` script.
#
# `--workspace-concurrency=1` is what actually orders the builds, and
# it is load-bearing rather than a throughput choice. Run in parallel,
# a package's declaration build reads a dependency's `dist` while that
# dependency is rebuilding it: tsup cleans its output directory first,
# so the reader either finds the previous declarations or finds
# nothing, depending on which won the race. The failure is a
# `Could not find a declaration file` error naming a workspace package
# that is being built in the same command, it lands in maybe a quarter
# of runs, and the retry that follows usually passes — which is what
# makes it read as infrastructure flake. The root `build` script has
# always run sequentially for the same reason.
pnpm --filter "$PKG_NAME..." --workspace-concurrency=1 --if-present build

# Working-dir handling: if the worker dir carries its own wrangler.toml
# / wrangler.jsonc, cd in so wrangler picks it up automatically. If
# not, stay at the repo root and let the caller pass `--config <path>`
# through the extra args.
if [[ -f "$WORKER_DIR/wrangler.toml" || -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  echo "→ wrangler deploy in $WORKER_DIR ($*)"
  cd "$WORKER_DIR"
else
  echo "→ wrangler deploy from repo root ($*)"
  echo "   $WORKER_DIR has no wrangler.toml/jsonc — pass --config via the extra args"
fi
exec wrangler deploy "$@"
