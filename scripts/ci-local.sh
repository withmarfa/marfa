#!/usr/bin/env bash
# Clean-install + all CI gates + both dialects. The "before opening a PR"
# check. Takes a few minutes but mirrors what CI will do on push, minimising
# the surprise-class of regression PR #7 surfaced (pre-install cached state
# masking real failures).
#
# Pre-push hook runs the faster subset (no clean install); this script is
# the explicit pre-PR gate.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "═══ ci-local: clean-slate install + all gates + both dialects ═══"
echo

echo "→ Wiping node_modules (clean install)"
rm -rf node_modules packages/*/node_modules

echo "→ pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo
echo "→ pnpm build"
pnpm build

echo
echo "→ pnpm typecheck"
pnpm typecheck

echo
echo "→ pnpm lint"
pnpm lint

echo
echo "→ pnpm format:check"
pnpm format:check

echo
echo "→ pnpm test:fresh-sqlite"
pnpm test:fresh-sqlite

echo
echo "→ pnpm test:pg"
pnpm test:pg

echo
echo "═══ ✓ ci-local passed — safe to open a PR ═══"
