# Changelog

## 0.1.0 — Unreleased

Initial release.

- Local-first reactive client for Myme, backed by a local PGlite database.
- Read path: subscribes to ElectricSQL shapes via the Myme server's
  `/sync/shapes/:family` proxy. Permission-filtered, tenant-scoped.
- Write path: optimistic mutations on items applied to an in-memory
  `OptimisticItemStore`, queued for drain via `@mymehq/sdk`. Replays
  are safe via the server-side `Idempotency-Key` middleware. PGlite
  is written exclusively by `@electric-sql/pglite-sync`; reads merge
  the canonical PGlite layer with the optimistic in-memory delta.
- React bindings under `@mymehq/sync-client/react`: `useItems`,
  `useItem`, `useEdges`, `useMutation`, `useSyncState`,
  `usePendingMutations`, `useSyncEvents`.
- Storage adapters for in-memory, IndexedDB (browser / Electron renderer),
  and Node filesystem (Electron main).

### Known limitations — items vs. edges/metadata writer split

Only **items mutations** flow through the `OptimisticItemStore` in
0.1.0 — `items.create / update / delete / restore / transition / purge`
are safe under round-trip replication.

The following operations still write directly to the PGlite tables
that `@electric-sql/pglite-sync` owns and will surface a primary-key
collision (`23505`) when the server-confirmed row replicates back via
Electric. They work correctly when the local store is empty (initial
sync) but are not yet safe for the create-then-replicate-back cycle:

- `items.create({ edges: { ... } })` — the atomic `edges` payload
  enqueues a `createItem` whose drain triggers server-side edge
  inserts; those edges then replicate via the edges shape and
  collide with any optimistic edge state. Single-item creation
  without `edges` is fine.
- `client.edges.create / update / delete` — local writes hit the
  PGlite `edges` table directly.
- `client.metadata.set / merge / addTags / removeTag` — local writes
  hit the PGlite `metadata` table directly.
- `client.metadata.setExtension / deleteExtension` — same.

**v0.2 will extend the `OptimisticItemStore` pattern** to cover
edges and metadata so the round-trip is safe end-to-end. Until
then, apps that rely on these operations should disable optimistic
behaviour for those code paths (await drain before treating the
write as applied) or treat round-trip failures as expected.

The integration suite explicitly skips round-trip assertions for
edges and metadata via `it.skip` with comments pointing at this
changelog entry.
