# @withmarfa/sdk

TypeScript HTTP client for the [Marfa](https://marfa.so) API.

```bash
pnpm add @withmarfa/sdk
```

```ts
import { MarfaClient } from "@withmarfa/sdk";

const client = new MarfaClient({
  url: "https://staging.marfa.so",
  apiKey: process.env.MARFA_API_KEY,
});

const note = await client.items.create({
  type: "core.note",
  properties: { title: "Hello", body: "World" },
});
```

## Surface

`client.{items,types,keys,edges,search,metadata,spaces,webhooks,connections,auth}` — one nested namespace per API surface. Methods return the unwrapped resource (e.g. `client.items.get` returns `Item`, not `{ item }`); errors throw typed `MarfaError` subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).

The OAuth helpers (PKCE, device flow, token storages, `MarfaAuth`) ship under the `@withmarfa/sdk/auth` subpath.

## Local engine

`@withmarfa/sdk/local` is a durable store for apps that must keep working with no network: a write lands on disk first and reaches the server afterwards. `@libsql/client` and `drizzle-orm` are optional peers, so a consumer that does not want one does not pay for it.

```ts
import {
  openLocalStore,
  createTypeGraph,
  createBlobStore,
  createLocalEngine,
} from "@withmarfa/sdk/local";

const store = await openLocalStore({ path: "./marfa.db", identity });
const types = createTypeGraph({ store, client });
const blobs = createBlobStore({ store, client });

await types.load(); // the cached type graph, with no network
const engine = createLocalEngine({ store, client, types, blobs });
await engine.start();
```

Three things it does that a network client cannot.

- **A write the type forbids is refused before it is queued**, by the same rules the server applies, so a person is told while the edit is still in front of them rather than an hour later. The type graph comes from `@withmarfa/shared` for platform types and from `GET /types` for custom ones, cached on disk. A type the client has never seen is not refused — the server decides what exists.
- **An attachment is usable at once.** `blobs.stage(bytes, mimeType)` hashes locally and returns the hash, so an item can reference it before anything is uploaded. The upload is queued and always lands before the write that names it; on reconnect a probe tells an upload that landed from one that was lost. An upload the server refuses for good is reported as a dead letter and the bytes are kept.
- **Search works offline**, over the same fields server search indexes, so a term that finds an item online finds it offline. Ranking may differ: both rank by BM25, which is relative to the documents in the index, and a local store holds what this client has rather than the whole space.

### Browser sign-out

Browser clients that request `openid` can end the hosted Marfa session with
the provider's RP-initiated logout endpoint. Clear the local token bundle
explicitly before navigating so the app is already signed out if navigation is
interrupted.

```ts
await auth.signOut(provider);
window.location.assign(
  await auth.buildBrowserSignOutUrl(`${window.location.origin}/`),
);
```

The post-logout return URI must be registered for the OAuth client. The SDK
throws before navigation when the stored session predates ID-token support; in
that case, send the user through a fresh sign-in before offering browser logout.

## Testing

The SDK ships two in-process test fixtures so consumers can exercise the client against a real Hono server without a network. Both are in `packages/sdk/src/test-harness.ts`.

### Keys-mode fixture (`createKeysModeFixture`)

For SDK surfaces that don't depend on `auth_user` resolution. Bootstraps the instance over `POST /keys` and returns a client wired to the working key that mint provisions.

```ts
import { createKeysModeFixture } from "./test-harness.js";

const { client, adminKey, cleanup } = await createKeysModeFixture();
try {
  const note = await client.items.create({
    type: "core.note",
    properties: { body: "Hello" },
  });
  expect(note.id).toBeTruthy();
} finally {
  cleanup();
}
```

### Hosted-mode fixture (`createHostedModeFixture`)

For SDK surfaces that resolve an `auth_user` from the bearer (account lifecycle, future passkey shims, anything that needs `client.auth.account.*`). Boots the server in `authMode: 'hosted'`, signs up a fresh user via the wrapped form endpoint (which provisions `spaces` + `users` bridge atomically), marks email-verified directly, and mints a key bound to the new user's space holding every space permission. The returned client uses that key as bearer; account-lifecycle routes resolve through the bridge.

```ts
import {
  createHostedModeFixture,
  readLatestAccountVerification,
} from "./test-harness.js";

const fixture = await createHostedModeFixture();
try {
  await fixture.client.auth.account.requestDelete();

  // The harness leaves emailTransport undefined; routes silently skip
  // send. The confirm token still lands in auth_verification.
  const token = await readLatestAccountVerification(
    fixture.storage,
    "account-delete:",
  );
  await fixture.client.auth.account.confirmDelete(token ?? "");

  await fixture.client.auth.account.cancel();
} finally {
  fixture.cleanup();
}
```

The fixture exposes `email`, `authUserId`, `spaceId`, and `bearerKey` for tests that need to assert on or interact with the underlying user — e.g. minting additional clients against the same space, or correlating audit rows.

### When to use which

| Surface under test                                                                   | Fixture                   |
| ------------------------------------------------------------------------------------ | ------------------------- |
| `items` / `edges` / `search` / `types` / `metadata` / `spaces` / `webhooks` / `keys` | `createKeysModeFixture`   |
| `auth.account.{requestDelete,confirmDelete,cancel}`                                  | `createHostedModeFixture` |
| Any future SDK surface that resolves `auth_user.id` from the bearer                  | `createHostedModeFixture` |

Both fixtures share the same SQLite-backed in-process server. PG matrix coverage of the SDK lives off this scope — it runs through the server's `test:pg` matrix on every PR, not the SDK's `pnpm test`.

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. `@withmarfa/types` declarations are inlined into the shared `.d.ts` so consumers only need `@withmarfa/sdk` and `@withmarfa/shared`.

## Versioning

Major bumps when `@withmarfa/shared` major-bumps (every wire-shape change cascades). Minor bumps for additive SDK features. Patch for bug fixes. Tag pushes (`v*`) trigger the OIDC-published release workflow; the workflow skips packages whose version is already on npm so unbumped packages are no-ops.
