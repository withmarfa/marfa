# @withmarfa/sdk

TypeScript HTTP client for the Marfa API. Public package, published to npm via OIDC trusted-publisher.

## Layout

- `src/client.ts` — the `MarfaClient` class. Each API surface lives in a nested object: `client.items`, `client.metadata`, `client.edges`, `client.blobs`, `client.types`, `client.keys`, `client.webhooks`, `client.connections`, `client.spaces`, `client.admin`, `client.auth`, `client.events`, `client.profile`, `client.occurrences`. Wire types come from `@withmarfa/shared`; the SDK adds ergonomic input/output types where convenient.
- `src/transport.ts` — `HttpTransport` wrapping `fetch` with auth, timeout, and JSON encoding/decoding. Tests inject a custom `fetch` to drive an in-process Hono app.
- `src/conflict.ts` — auto-merge / manual / callback conflict resolution for `client.items.update` (`auto` is the default; auto strategy resolves non-conflicting fields, surfaces real conflicts via `keep_both_copies` sibling items per the schema's merge_policy).
- `src/pagination.ts` — `paginate` (stream a cursor-paginated endpoint) and `collect` (drain one into an array, up to a ceiling the caller names). The `listAll*` methods on the client are one-line wrappers over `paginate`; nothing else re-implements the walk.
- `src/errors.ts` — typed `MarfaError` subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).
- `src/define-type.ts` — `defineType()` authoring helper. No-op at runtime; constrains the input to a structurally-valid `TypeSchema` at compile time.
- `src/webhooks.ts` — inbound webhook signature verification (`verifyWebhookSignature`).
- `src/local/` — the durable local engine, published as `@withmarfa/sdk/local`. Its own tsup entry, with `@libsql/client` and `drizzle-orm` as optional peers, so a consumer that does not want a local store does not pay for one. `store/` is the SQLite half (server state in three layers, the outbox, dead letters, sync state, the cached type graph, the blob queue and cache, the search index); `drain.ts`, `sync.ts`, `apply.ts` and `import.ts` are the sending, streaming and hydrating halves; `projection.ts` feeds a TanStack DB collection. Store migrations are hand-written under `drizzle/local/` — SQL plus a journal entry, the same shape the server uses, with no generator.

## The local engine: types, blobs, search

Three behaviors that only exist on the local engine, and each of them changes what a caller sees.

- **A write is validated before it is queued.** `store.mutations.createItem` and `updateItem` run `validateProperties` against the process registry, scoped to the store's own space, and throw `LocalSchemaRefusal` rather than enqueuing. An update is validated as the merged row, not as the patch. **A type the client has never heard of is not refused** — the server is the authority on what types exist, and a store whose cache is cold has to be able to write.
- **The type graph is cached.** `createTypeGraph({ store, client })` reads `GET /types`, registers the payload through `hydrateTypeRegistry` and writes it to `cached_types`; `load()` registers what the store already holds, with no network. Pass the graph to `createOutboxDrain` or `createLocalEngine` and a schema refusal from the server buys one refresh and one revalidation before it is treated as permanent, recorded on the outbox row so the allowance is once per mutation rather than once per pass. **Two server codes mean the same refusal** (`validation_error` from the create door, `invalid_properties` from the rest), and the classification accepts both.
- **Blobs queue with their bytes.** `createBlobStore({ store, client })` hashes locally, writes the bytes beside the store, and queues the upload; the reference can go on an item immediately. Pass it to the drain and every upload lands before any write that names it. On replay a `HEAD /blobs/:hash` probe tells an upload that landed from one that was lost. An upload refused for good dead-letters the writes waiting on it and **keeps the bytes**, which leave only through `discard`. The read-through cache is bounded by total bytes and evicts the least recently read; staged bytes are never candidates.
- **Search is offline.** `store.search.find(query, filters)` runs FTS5 over the same fields server search indexes — the four core fields plus every other searchable string field the type declares — so the same term finds the same items. **Ranking may differ**: both order by bm25, and bm25 is relative to the documents in the index. Results resolve through visible state, so an unsent write is findable and a queued delete is not returned.

**Two properties are easy to break silently.** The search index is created on the raw libsql client at open, because drizzle cannot express a virtual table; an index found absent is refilled from the store, since an empty one answers every search with nothing and looks exactly like a search that matched nothing. And transactions are serialized per store handle, because libsql runs an interactive transaction on a connection of its own and a second `BEGIN` is refused outright rather than waiting — a busy timeout cannot help there, since the connection being refused is libsql's.

## Subpaths with optional peers

`./auth`, `./auth/node`, `./replica`, `./local`, `./electron`,
`./electron/preload` and `./electron/renderer` each have their own tsup entry,
so a consumer pays only for what it imports. `@tanstack/db`, `@libsql/client`, `drizzle-orm` and
`electron` are optional peers and externalized in the bundle.

**`electron` is also a devDependency**, which the others are too but for a
sharper reason: `./electron` is typed against Electron's own `IpcMain`,
`WebContents` and `WebPreferences` rather than against narrowed stand-ins, so
the subpath cannot typecheck without the real declarations. A stand-in has to
be kept in step with the thing it stands for, and the version that is not is
the one that compiles while the application does not.

**The three electron entries split for a harder reason than tree-shaking.** A
sandboxed Electron preload is bundled into one CommonJS file and given a
`require` that resolves `electron` and a few builtins and nothing off disk, so
it can never load a native addon. An application bundling its preload against
a combined entry would pull the store — and `@libsql/client` with it — into
exactly that context. `./electron` is the main-process half;
`./electron/preload` touches nothing but `contextBridge` and `ipcRenderer`.

`./electron/renderer` is the third because a renderer can import neither of
the others: one pulls the store, the other imports `electron`. It carries the
channel names, the bridge's type and `refusalNameOf`, and its chunk imports
nothing at all. A renderer needs that helper rather than reading `error.name`
directly, because `contextBridge` discards an Error's own properties on the
way across, so the class survives only in the message.

## Surface design

- **Wire types are re-exported from `@withmarfa/shared`.** Don't redefine `Item`, `ApiKey`, etc. The SDK adds `ListFilters`, `SearchFilters`, `BulkInput`, `UpdateOptions`, `ConflictStrategy` — input/output sugar that doesn't belong on the server's wire shape.
- **Methods return the unwrapped resource.** The server returns `{ item: Item, metadata: Metadata }`; the SDK returns `Item` from `client.items.get`. List methods return `PaginatedResult<T>`. `client.occurrences.list` is the exception on both counts: it is not paginated, and it returns the whole envelope because `series_errors` reports the series that failed to expand, which unwrapping would discard.
- **Errors throw, not return.** Every method either resolves with the success type or throws a typed `MarfaError` subclass.
- **Idempotency-key support is opt-in.** Methods that accept it take an `idempotency_key` option; the transport sets the header.

## Testing

The suite runs against an in-process Hono server (uses `@withmarfa/server`'s `createApp` directly), not a mock: bootstrap admin keys are created over the `/keys` HTTP path so tests exercise the full server. It spans the client surface, the auth helpers, and the local replica.

Run it from the repository root, which resolves the workspace project correctly:

```bash
pnpm exec vitest run --project @withmarfa/sdk
```

The replica tests need the optional `@tanstack/db` peer installed. When a test depends on a server-side change, rebuild `@withmarfa/shared` and `@withmarfa/server` first (`pnpm --filter @withmarfa/shared build`) so the SDK picks up the new dist.

`src/local/scenarios.test.ts` carries the sync contract's scenario list, each test naming the offline-seam mode it uses in its title. **A local scenario that asserts on a custom type hydrates into a space of its own.** `@withmarfa/shared` is external to the server's bundle, so the in-process server and the test share one module-level type registry: a type registered over `POST /types` is already in the registry a local validation would read, and hydrating into the same space would prove nothing about the hydration.

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. `@withmarfa/types` declarations are inlined into the shared `.d.ts` so consumers only need `@withmarfa/sdk` and `@withmarfa/shared`.

## Native platform packages, and why `createRequire` is not used to find them

`src/electron/native-targets.ts` answers whether a desktop artifact carries a
SQLite binding the machine it was built for can load. It walks `node_modules`
up from a directory by hand rather than calling `require.resolve`, and that is
load-bearing: **`createRequire` is not reliably Node's resolver.** Run under
`tsx` it answers from a broader search, so a platform package merely present
somewhere in a pnpm store resolves as though the application depended on it.
The first version of the packaging check did exactly that and reported five
sound platforms with one of them uninstalled — the failure it exists to catch,
passing. Vitest patches resolution in the same direction, so a test could not
have caught it either.

It reads the object-file header rather than asking whether a file is present,
because the shape being guarded against — the build host's binary sitting
where another platform's belongs — looks like a healthy install from the
filename down.

`LIBSQL_NATIVE_TARGETS` is a copy of `libsql`'s own `optionalDependencies`, and
`native-targets.test.ts` holds it to the original rather than to a reading of
it.

## Versioning

Major bumps when `@withmarfa/shared` major-bumps (every wire-shape change cascades). Minor bumps for additive SDK features. Patch for bug fixes. Tag pushes (`v*`) trigger the publish workflow; the workflow skips packages whose version is already on npm so unbumped packages are no-ops.

**`@tanstack/db` is a `>=0.6.17 <0.9.0` range and not a caret, deliberately.** On a 0.x package a
caret admits only the same minor, so `^0.8.0` and `^0.6.17` are disjoint: narrowing one to the other
strands every consumer on the older line, and it did, in 2.3.0. The replica surface touches two
symbols from that package, `createCollection` and the `Collection` type, and the binding constraint
is `Collection<Item, string, ReplicaUtils>`, three type parameters, which is what an older release
fails to satisfy. The surface typechecks against 0.4.20 through 0.8.4 and fails on 0.2.5, so the
range is narrower than what works rather than a guess. Widening it further is safe; narrowing it is
a breaking change to an optional peer and wants a major.
