# Changelog

## 0.1.0 — Unreleased

Initial release.

- Local-first reactive client for Myme, backed by a local PGlite database.
- Read path: subscribes to ElectricSQL shapes via the Myme server's
  `/sync/shapes/:family` proxy. Permission-filtered, tenant-scoped.
- Write path: optimistic mutations applied to a TanStack DB collection
  layered on top of PGlite, queued for drain via `@mymehq/sdk`. Replays
  are safe via the server-side `Idempotency-Key` middleware.
- React bindings under `@mymehq/sync-client/react`: `useItems`,
  `useItem`, `useEdges`, `useMutation`, `useSyncState`,
  `usePendingMutations`, `useSyncEvents`.
- Storage adapters for in-memory, IndexedDB (browser / Electron renderer),
  and Node filesystem (Electron main).
