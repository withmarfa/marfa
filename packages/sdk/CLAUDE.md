# @mymehq/sdk

TypeScript HTTP client for the Myme API. Public package, published to npm via OIDC trusted-publisher.

## Layout

- `src/client.ts` — the `MymeClient` class. Each API surface lives in a nested object (`client.items`, `client.types`, `client.keys`, `client.edges`, `client.search`, `client.metadata`, `client.tenants`, `client.webhooks`). Wire types come from `@mymehq/shared`; the SDK adds ergonomic input/output types where convenient.
- `src/transport.ts` — `HttpTransport` wrapping `fetch` with auth, timeout, and JSON encoding/decoding. Tests inject a custom `fetch` to drive an in-process Hono app.
- `src/conflict.ts` — auto-merge / manual / callback conflict resolution for `client.items.update` (`auto` is the default; auto strategy resolves non-conflicting fields, surfaces real conflicts via `keep_both_copies` sibling items per the schema's merge_policy).
- `src/errors.ts` — typed `MymeError` subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).
- `src/define-type.ts` — `defineType()` authoring helper (TSC42 §7). No-op at runtime; constrains the input to a structurally-valid `TypeSchema` at compile time.
- `src/webhooks.ts` — inbound webhook signature verification (`verifyWebhookSignature`).

## Surface design

- **Wire types are re-exported from `@mymehq/shared`.** Don't redefine `Item`, `ApiKey`, etc. The SDK adds `ListFilters`, `SearchFilters`, `BulkInput`, `UpdateOptions`, `ConflictStrategy` — input/output sugar that doesn't belong on the server's wire shape.
- **Methods return the unwrapped resource.** The server returns `{ item: Item, metadata: Metadata }`; the SDK returns `Item` from `client.items.get`. List methods return `PaginatedResult<T>`.
- **Errors throw, not return.** Every method either resolves with the success type or throws a typed `MymeError` subclass.
- **Idempotency-key support is opt-in.** Methods that accept it take an `idempotency_key` option; the transport sets the header.

## Testing

`pnpm test` runs `client.test.ts` against an in-process Hono server (uses `@mymehq/server`'s `createApp` directly). Bootstrap admin key is created over the `/keys` HTTP path so the test exercises the full server, not a mock.

When a test depends on a server-side change, rebuild `@mymehq/shared` and `@mymehq/server` first (`pnpm --filter @mymehq/shared build`) so the SDK picks up the new dist.

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. `@mymehq/types` declarations are inlined into the shared `.d.ts` so consumers only need `@mymehq/sdk` and `@mymehq/shared`.

## Versioning

Major bumps when `@mymehq/shared` major-bumps (every wire-shape change cascades). Minor bumps for additive SDK features. Patch for bug fixes. Tag pushes (`v*`) trigger the publish workflow; the workflow skips packages whose version is already on npm so unbumped packages are no-ops.
