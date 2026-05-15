# @mymehq/sdk

TypeScript HTTP client for the [Myme](https://myme.so) API.

```bash
pnpm add @mymehq/sdk
```

```ts
import { MymeClient } from "@mymehq/sdk";

const client = new MymeClient({
  url: "https://staging.myme.so",
  apiKey: process.env.MYME_API_KEY,
});

const note = await client.items.create({
  type: "core.note",
  properties: { title: "Hello", body: "World" },
});
```

## Surface

`client.{items,types,keys,edges,search,metadata,tenants,webhooks,connections,auth}` — one nested namespace per API surface. Methods return the unwrapped resource (e.g. `client.items.get` returns `Item`, not `{ item }`); errors throw typed `MymeError` subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).

The OAuth helpers (PKCE, device flow, token storages, `MymeAuth`) ship under the `@mymehq/sdk/auth` subpath.

## Testing

The SDK ships two in-process test fixtures so consumers can exercise the client against a real Hono server without a network. Both are in `packages/sdk/src/test-harness.ts`.

### Keys-mode fixture (`createKeysModeFixture`)

For SDK surfaces that don't depend on `auth_user` resolution. Bootstraps a platform-admin API key over `POST /keys` and returns a client wired to it.

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

For SDK surfaces that resolve an `auth_user` from the bearer (account lifecycle, future passkey shims, anything that needs `client.auth.account.*`). Boots the server in `authMode: 'hosted'`, signs up a fresh user via the wrapped form endpoint (which provisions `tenants` + `users` bridge atomically), marks email-verified directly, and mints a `workspace_admin` API key bound to the new user's tenant. The returned client uses that key as bearer; account-lifecycle routes resolve through the bridge.

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

The fixture exposes `email`, `authUserId`, `tenantId`, and `bearerKey` for tests that need to assert on or interact with the underlying user — e.g. minting additional clients against the same tenant, or correlating audit rows.

### When to use which

| Surface under test                                                                    | Fixture                   |
| ------------------------------------------------------------------------------------- | ------------------------- |
| `items` / `edges` / `search` / `types` / `metadata` / `tenants` / `webhooks` / `keys` | `createKeysModeFixture`   |
| `auth.account.{requestDelete,confirmDelete,cancel}`                                   | `createHostedModeFixture` |
| Any future SDK surface that resolves `auth_user.id` from the bearer                   | `createHostedModeFixture` |

Both fixtures share the same SQLite-backed in-process server. PG matrix coverage of the SDK lives off this scope — it runs through the server's `test:pg` matrix on every PR, not the SDK's `pnpm test`.

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. `@mymehq/types` declarations are inlined into the shared `.d.ts` so consumers only need `@mymehq/sdk` and `@mymehq/shared`.

## Versioning

Major bumps when `@mymehq/shared` major-bumps (every wire-shape change cascades). Minor bumps for additive SDK features. Patch for bug fixes. Tag pushes (`v*`) trigger the OIDC-published release workflow; the workflow skips packages whose version is already on npm so unbumped packages are no-ops.
