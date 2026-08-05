# @withmarfa/runtime-sdk

The SDK that Connection integrations import. Provides the handler-registration API, per-Connection state primitives, the connection-scoped client, echo suppression, and the dispatch glue both runtime substrates call into. Private package — workspace-only.

## Layout

Two exported entries:

- **`@withmarfa/runtime-sdk`** (root) — substrate-agnostic surface. Imported by integration handler modules and by both substrates. No dependency on `@cloudflare/workers-types` runtime symbols — handler code written against this entry is portable across substrates.
- **`@withmarfa/runtime-sdk/cloudflare`** — Cloudflare-specific bootstrap. `createIntegrationWorker`, the `PerConnectionState` Durable Object class, the DO storage proxy, the worker entry. Imported only by the hosted-substrate per-Integration Workers.

The root/cloudflare split is enforced so the local runtime substrate (`@withmarfa/server/src/integrations/local-runtime/`) can import the root entry and supply its own concrete state / dispatch wiring without dragging Workers-runtime types into the Node server bundle.

Inside `src/`:

- `index.ts` — root re-exports: `registerScheduleHandler`, `registerWebhookHandler`, `registerItemEventHandler`, `dispatchMessage`, `PerConnectionStateCore`, type aliases for the handler signatures.
- `cloudflare/index.ts` — re-exports the Cloudflare bootstrap (`createIntegrationWorker`), the `PerConnectionState` DO class, the worker entry shim.
- `handlers.ts` — handler `REGISTRY` and `dispatchMessage`. Module-singleton state — both substrates resolve to the same instance via shared's `noExternal` rule (see "Module singleton" below).
- `per-connection-state.ts` — `PerConnectionStateCore`: the substrate-agnostic cursor / idempotency / recent-errors / next-run-at machinery. The Cloudflare DO subclasses it to add Workers-specific storage; the local substrate consumes it via the executor's in-memory adapter.
- `connection-client.ts` — `ConnectionClient`: thin wrapper over `@withmarfa/sdk` that stamps the cycle-metadata headers (`X-Marfa-Cycle-Origin`, `X-Marfa-Cycle-Hop`) and the connection's runtime credential.
- `connection-context.ts` — `ConnectionContext`: the object passed into every handler invocation. Holds the client, cursor, activity emitter, dispatch metadata.
- `cron.ts` — cron-expression resolution (`cron-parser`) for schedule handlers.
- `cursor-store.ts` — cursor-window primitives.
- `echo-suppression.ts` — exact-match, TTL-expiring suppression of events the integration itself just wrote, keyed per external id (prevents fanout-loops within hop-budget). Not probabilistic: a plain key-value record with an expiry, so there are no false positives to reason about.
- `activity.ts` — helpers for emitting `system.activity` rows.
- `queue-consumer.ts` — Cloudflare-side queue consumer (retry / DLQ / hop-budget enforcement). The local substrate reproduces the same semantics in `local-runtime/supervisor.ts`.

## Authoring rules

- **Module singleton — both packages externalized.** `@withmarfa/runtime-sdk` MUST be marked external in any bundle that loads integrations alongside it (the server bundle, the per-Integration Workers, the worker-entry script). The handler `REGISTRY` in `handlers.ts` is module-level state — if duplicated across the boundary the dispatch lookup silently misses. The same constraint applies to `@withmarfa/shared` (the type / edge / zod-schema caches). The smoke at `pnpm --filter @withmarfa/server run smoke:worker-entry` is the build-time tripwire.
- **Substrate-agnostic by default.** New surface goes in the root entry unless it genuinely needs Workers types or runtime symbols. If it needs Cloudflare, it lives under `src/cloudflare/`.
- **No `console.log`.** Handlers emit through `system.activity` (severity-tagged) via the `activity.ts` helpers; the substrate aggregates and persists.

## Build

`tsup` produces both entry points: `dist/index.{js,d.ts}` and `dist/cloudflare/index.{js,d.ts}`. The package is consumed via the workspace link during dev and via the published `@withmarfa/sdk` floor at release time (it depends on the SDK and `@withmarfa/shared`).

## Testing

`pnpm test` runs the Vitest suite. Coverage spans handler registration + dispatch (`handlers.test.ts`), cursor + echo-suppression semantics, the connection client's cycle-header stamping, queue-consumer retry / DLQ behavior, cron resolution, activity-emission shape, and the Cloudflare worker-entry composition (`cloudflare/worker-entry.test.ts`). All tests run under Node — the Workers-specific surfaces are exercised against the `in-memory-storage.ts` adapter rather than Miniflare.
