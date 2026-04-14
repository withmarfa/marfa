# @mymehq/electric — PARKED

> **This package is parked.** It is excluded from the pnpm workspace and the CI build, lint, typecheck, and test pipelines. The code remains on disk for future revival but is not maintained.

## Why parked

The Electric mirror was built as an experimental local-first sync layer for browser/desktop clients. Two things changed during V0 design:

1. **No active consumer.** The Swift SDK builds its own local-first stack (CoreData / SwiftData) and doesn't use Electric. No other downstream client has materialised that needs an Electric-shaped mirror.
2. **Schema drift cost.** Every time the server's Item / Metadata shape changes (Wave 1 added `library` and renamed `device_id`; PR 1 of Wave 2 stamped `schema_version`; the broader Wave 2 will add edges) the mirror needs a parallel update. With no consumer that exercises the mirror, these updates went silently broken — the V0 review flagged the mirror's missing `library` column and stale `state` default as still uncorrected post-Wave-1.

Rather than maintain a mirror nobody uses, V0 Wave 2 PR 2 parks the package: code stays on disk, package metadata marks it deprecated, the workspace excludes it. This removes the upkeep cost without losing the work-done value.

## How to revive

If a future client genuinely needs an Electric-backed local mirror:

1. Re-add `packages/electric` to the workspace by removing the `!packages/electric` exclusion in `pnpm-workspace.yaml`.
2. Drop the `private: true` and `deprecated` fields from `package.json`; set a real `version`.
3. Bring the `local/schema.ts`, `local/helpers.ts`, and `local/stores/*.ts` files back in line with the current server Item / Metadata shape (the package was last in sync with main as of merge `4c05b3d`; subsequent V0 work has shifted the Item shape).
4. Run `pnpm install` from the root; verify `pnpm --filter @mymehq/electric typecheck` passes.

## Status snapshot at park time

- Last in-sync merge: `4c05b3d` (V0 Wave 1)
- Known drift since: missing `library` column, missing `extensions` column on metadata table, default state still `"new"` (Wave 1 dropped that state). PR 1 of Wave 2 patched the helper coercions so the package still typechecks against the tightened `Item` interface but did not fix the schema drift.
- Test suite: 3 test files, all expected to pass against the package as of the park commit. Excluded from the root `pnpm test` going forward.
