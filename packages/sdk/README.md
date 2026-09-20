# @withmarfa/sdk

TypeScript HTTP client for the [Marfa](https://marfa.so) API.

```bash
pnpm add @withmarfa/sdk
```

```ts
import { MarfaClient } from "@withmarfa/sdk";

// Reads MARFA_API_URL and MARFA_API_KEY; null if either is unset.
const client = MarfaClient.fromEnvironment();
if (!client) throw new Error("MARFA_API_URL and MARFA_API_KEY must be set");

const note = await client.items.create({
  type: "core.note",
  properties: { title: "Hello", body: "World" },
});
```

## Surface

`client.{items,types,keys,edges,blobs,metadata,config,webhooks,events,occurrences,admin}` — one nested namespace per API surface, and `client.search` beside them as a method rather than a namespace. Methods return the unwrapped resource (e.g. `client.items.get` returns `Item`, not `{ item }`); errors throw typed `MarfaError` subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).

## Testing

The SDK ships one in-process test fixture so consumers can exercise the client against a real Hono server without a network. It lives in `packages/sdk/src/test-harness.ts`.

### Bootstrapped fixture (`createBootstrappedFixture`)

Bootstraps the instance over `POST /keys` and returns a client wired to the working key that mint provisions.

```ts
import { createBootstrappedFixture } from "./test-harness.js";

const { client, adminKey, cleanup } = await createBootstrappedFixture();
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

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. `@withmarfa/types` declarations are inlined into the shared `.d.ts` so consumers only need `@withmarfa/sdk` and `@withmarfa/shared`.

## Versioning

Major bumps when `@withmarfa/shared` major-bumps (every wire-shape change cascades). Minor bumps for additive SDK features. Patch for bug fixes. Tag pushes (`v*`) trigger the OIDC-published release workflow; the workflow skips packages whose version is already on npm so unbumped packages are no-ops.
