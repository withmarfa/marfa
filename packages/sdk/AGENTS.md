# @withmarfa/sdk

TypeScript HTTP client for the Marfa API. Public package, published to npm via OIDC trusted-publisher. The surface is organised as nested objects on `MarfaClient` (`client.items`, `client.edges`, and so on); `src/local/` is the durable local engine, published as `@withmarfa/sdk/local`.

## Surface design

- **Wire types are re-exported from `@withmarfa/shared`.** Never redefine `Item` or `ApiKey` here. The SDK adds input and output sugar (`ListFilters`, `BulkInput`, `ConflictStrategy`) that does not belong on the server's wire shape.
- **Methods return the unwrapped resource.** The server returns an envelope; `client.items.get` returns the `Item`. `client.occurrences.list` is the exception on purpose: it is not paginated and returns the whole envelope, because `series_errors` reports the series that failed to expand and unwrapping would discard it.
- **Errors throw, typed.** Every method resolves with the success type or throws a `MarfaError` subclass.
- **`paginate` and `collect` are the only pagination walk.** The `listAll*` methods are one-line wrappers; nothing else re-implements it.
- **Local store migrations are hand-written**, SQL plus a journal entry, the same shape the server uses and with no generator.

## The local engine

Four behaviours that only exist locally, each of which changes what a caller sees.

- **A write is validated before it is queued**, against the process registry scoped to the store's own space, and an update is validated as the merged row rather than as the patch. **A type the client has never heard of is not refused**: the server is the authority on what types exist, and a store with a cold cache has to be able to write.
- **The type graph is cached**, and a schema refusal from the server buys one refresh and one revalidation before it is treated as permanent, recorded on the outbox row so the allowance is once per mutation rather than once per pass. **Two server codes mean the same refusal** and the classification accepts both.
- **Blobs queue with their bytes.** The reference can go on an item immediately, and every upload lands before any write that names it. On replay a `HEAD /blobs/:hash` probe distinguishes an upload that landed from one that was lost. An upload refused for good dead-letters the writes waiting on it and **keeps the bytes**, which leave only through `discard`.
- **Search is offline**, over the same fields the server indexes, so the same term finds the same items. **Ranking may differ**, because bm25 is relative to the documents in the index. Results resolve through visible state, so an unsent write is findable and a queued delete is not returned.

**Two properties are easy to break silently.** The search index is created on the raw libsql client at open, because Drizzle cannot express a virtual table, and an index found absent is refilled from the store, because an empty one answers every search with nothing and looks exactly like a search that matched nothing. And transactions are serialized per store handle, because libsql runs an interactive transaction on a connection of its own and a second `BEGIN` is refused outright rather than waiting, so a busy timeout cannot help.

## Subpaths and optional peers

Each subpath has its own tsup entry so a consumer pays only for what it imports, with `@tanstack/db`, `@libsql/client`, `drizzle-orm` and `electron` as optional peers.

**The three Electron entries split for a harder reason than tree-shaking.** A sandboxed preload is bundled into one CommonJS file and given a `require` that resolves `electron` and a few builtins and nothing off disk, so it can never load a native addon; an application bundling its preload against a combined entry would pull the store, and `@libsql/client` with it, into exactly that context. `./electron` is the main-process half and `./electron/preload` touches nothing but `contextBridge` and `ipcRenderer`. `./electron/renderer` exists because a renderer can import neither of the others, and it carries `refusalNameOf` because `contextBridge` discards an Error's own properties on the way across, so the class survives only in the message.

**`electron` is a devDependency as well as a peer**, because `./electron` is typed against Electron's own declarations rather than narrowed stand-ins: a stand-in has to be kept in step with the thing it stands for, and the version that is not is the one that compiles while the application does not.

## Native platform packages

`src/electron/native-targets.ts` answers whether a desktop artifact carries a SQLite binding the target machine can load. It walks `node_modules` by hand rather than calling `require.resolve`, and that is load-bearing: **`createRequire` is not reliably Node's resolver.** Under `tsx` it answers from a broader search, so a platform package merely present somewhere in a pnpm store resolves as though the application depended on it. The first version of the check did exactly that and reported five sound platforms with one of them uninstalled, which is the failure it exists to catch, passing. Vitest patches resolution the same way, so a test could not have caught it either. It reads the object-file header rather than asking whether a file is present, because the build host's binary sitting where another platform's belongs looks like a healthy install from the filename down.

## Versioning

Major when `@withmarfa/shared` majors, since every wire-shape change cascades, **and when a published surface is removed**, meaning a subpath or an exported name, which the surface lock enforces rather than trusts. Minor for additive features, patch for fixes. The publish workflow skips packages whose version is already on npm.

**`@tanstack/db` is a range rather than a caret, deliberately.** On a 0.x package a caret admits only the same minor, so two carets on different minors are disjoint and narrowing one to the other strands every consumer on the older line, which it did once. The floor is held by the projection binding three type parameters on `Collection`, which older releases fail to satisfy. Whether the projection alone holds the floor at exactly the current lower bound has not been measured, and the range is not narrowed on an assumption that it does. Widening it is safe; narrowing it is a breaking change to an optional peer and wants a major.

## Testing

The suite runs against an in-process Hono server using the server package's own `createApp`, not a mock, so tests exercise the real request path. Run it from the repository root (`pnpm exec vitest run --project @withmarfa/sdk`); a test depending on a server-side change needs `@withmarfa/shared` and `@withmarfa/server` rebuilt first.

**A local scenario asserting on a custom type hydrates into a space of its own.** `@withmarfa/shared` is external to the server's bundle, so the in-process server and the test share one module-level registry: a type registered over `POST /types` is already in the registry a local validation would read, and hydrating into the same space would prove nothing.
