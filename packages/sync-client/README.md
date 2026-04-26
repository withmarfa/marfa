# @mymehq/sync-client

Local-first reactive client for [Myme](https://github.com/mymehq/myme). Gives JavaScript apps — primarily Electron, also browser — instant reads from a local PGlite database, optimistic writes that drain through a durable queue, and live queries that update when the server streams changes back via ElectricSQL.

The mental model mirrors the Swift SDK's `synced` mode. JavaScript apps now have an equivalent.

## Architecture in one paragraph

Reads go through a local PGlite database, kept in sync with Myme's Postgres via per-API-key ElectricSQL shapes. Writes apply optimistically to a TanStack DB collection layer (in-memory) and queue for drain to Myme's HTTP API. The Myme server is canonical — it validates types, enforces permissions, runs audit and webhooks. The sync-client never owns truth; it just makes the local view fast.

```
App ───► useItems / useItem (TanStack DB live query)
            │
            ▼
         PGlite (items, edges, metadata)
            ▲
            │ pglite-sync
            │
   Myme API /sync/shapes/:family ◄── Electric ◄── Postgres
            ▲                                       ▲
            │                                       │
   App ───► client.items.update(...)                │
            │                                       │
            ▼ optimistic                            │
        TanStack DB optimistic layer                │
            │                                       │
            ▼ enqueue                               │
       _myme_mutation_queue (PGlite)                │
            │                                       │
            ▼ drain via @mymehq/sdk                 │
   Myme API ──► server validates/applies ───────────┘
```

## Install

```bash
pnpm add @mymehq/sync-client
```

## Quickstart (Electron renderer)

```ts
import { MymeSyncClient } from '@mymehq/sync-client';

const client = new MymeSyncClient({
  apiUrl: 'https://atlas.local:8602',
  apiKey: 'myme_k1_…',
  storage: 'idb:myme-app',
});

await client.start();

// Read items reactively (see /react for hooks)
const items = await client.items.list({ type: 'core.note' });

// Optimistic write — UI reflects this instantly; server confirms async
const note = await client.items.create({
  type: 'core.note',
  properties: { title: 'Hello', body: 'world' },
});
```

## React

```tsx
import { MymeSyncProvider, useItems, useMutation } from '@mymehq/sync-client/react';

function App() {
  return (
    <MymeSyncProvider client={client}>
      <NoteList />
    </MymeSyncProvider>
  );
}

function NoteList() {
  const { data, isLoading } = useItems('core.note', { state: 'active' });
  if (isLoading) return null;
  return data.map((n) => <Note key={n.id} note={n} />);
}
```

## Testing

Two tiers:

```bash
# Unit — runs in `pnpm test`, in-process PGlite, no network. Fast.
pnpm --filter @mymehq/sync-client test

# Integration — opt-in. Spawns the local Myme server (worktree code)
# against Atlas Postgres + Atlas Electric. Self-skips when Atlas is
# unreachable.
pnpm --filter @mymehq/sync-client test:integration
```

The integration suite needs four env vars:

- `MYME_INTEGRATION_DATABASE_URL` — e.g. `postgres://myme@aic-atlas:5432/myme_mock?sslmode=disable`
- `MYME_INTEGRATION_ELECTRIC_URL` — e.g. `http://aic-atlas:8604`
- `MYME_INTEGRATION_SALT` — the API key salt of the Atlas mock instance
- `MYME_INTEGRATION_API_KEY` — a `myme_k1_…` key valid against the same instance

If any are missing, or if Atlas Postgres / Electric are unreachable, the suite skips cleanly with a warning rather than producing red CI. Mirrors the freshness-job precedent in the repo's `CLAUDE.md`.

## Status

This package is in active development. The API may change until 1.0.

## License

ISC
