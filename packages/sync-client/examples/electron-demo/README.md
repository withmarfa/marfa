# sync-client Electron demo

Minimal Electron app exercising `@mymehq/sync-client` end-to-end:

- Optimistic note create (`useItems` + `useMutation`).
- Sync state indicator (`useSyncState`, `usePendingMutations`).
- Mutation-rejection toast (`useSyncEvents('mutation.rejected')`).
- IndexedDB-backed PGlite (`storage: 'idb:myme-sync-client-demo'`) so writes survive app restart.
- CSP set to allow `wasm-unsafe-eval` so PGlite's WASM compiles in the renderer.

## Run

The demo doesn't ship a build pipeline (intentionally minimal). To run:

```bash
# 1. set creds
export MYME_API_URL=http://atlas.local:8602
export MYME_API_KEY=myme_k1_…   # or pipe through keytar in main.ts

# 2. compile main + preload to dist/ (use any TS-to-CJS bundler)
# 3. launch electron pointing at dist/main.cjs
```

In a production app, replace the `process.env.MYME_API_KEY` lookup in `electron/preload.ts` with a `keytar.getPassword('myme.sync-client', 'default')` call from `electron/main.ts`. Don't hard-code keys.

## Things to try

1. **Offline writes.** Create a note. Disconnect network. Edit the note. The UI updates instantly. Reconnect — the queue drains and the canonical row replaces the optimistic state.
2. **Conflict surfacing.** While the demo is open, run `my items update <id> --properties.title='changed'` against the same Atlas instance with a different key. The conflict event fires, the toast appears.
3. **Restart durability.** Add notes, kill the app, relaunch. The notes are still there (loaded from the IndexedDB-backed PGlite). Pending writes resume draining.
