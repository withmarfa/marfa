# @withmarfa/runtime-sdk

The SDK that Connection integrations import. Provides the handler-registration API, per-Connection state primitives, the connection-scoped client, echo suppression, and the dispatch glue the server's integration runtime calls into. Private package — workspace-only.

## Layout

Inside `src/`:

- `index.ts` — re-exports: `registerScheduleHandler`, `registerWebhookHandler`, `registerItemEventHandler`, `dispatchMessage`, `PerConnectionStateCore`, type aliases for the handler signatures.
- `handlers.ts` — handler `REGISTRY` and `dispatchMessage`. Module-singleton state — every loader resolves to the same instance via shared's `noExternal` rule (see "Module singleton" below).
- `per-connection-state.ts` — `PerConnectionStateCore`: the cursor / idempotency / recent-errors / next-run-at machinery, consumed via the executor's in-memory adapter.
- `connection-client.ts` — `ConnectionClient`: thin wrapper over `@withmarfa/sdk` that stamps the cycle-metadata headers (`X-Marfa-Cycle-Origin`, `X-Marfa-Cycle-Hop`) and the connection's runtime credential.
- `connection-context.ts` — `ConnectionContext`: the object passed into every handler invocation. Holds the client, cursor, activity emitter, dispatch metadata.
- `cron.ts` — cron-expression resolution (`cron-parser`) for schedule handlers.
- `cursor-store.ts` — cursor-window primitives.
- `echo-suppression.ts` — exact-match, TTL-expiring suppression of events the integration itself just wrote, keyed per external id (prevents fanout-loops within hop-budget). Not probabilistic: a plain key-value record with an expiry, so there are no false positives to reason about.
- `activity.ts` — helpers for emitting `system.activity` rows.
- `queue-consumer.ts` — `consumeBatch`, the dispatch engine (retry / DLQ / hop-budget enforcement) over structural `QueueDeliveryMessage` envelopes. The server's supervisor mirrors its semantics; the runtime-test harness drives it directly.

## Authoring rules

- **Module singleton — both packages externalized.** `@withmarfa/runtime-sdk` MUST be marked external in any bundle that loads integrations alongside it (the server bundle, the worker-entry script). The handler `REGISTRY` in `handlers.ts` is module-level state — if duplicated across the boundary the dispatch lookup silently misses. The same constraint applies to `@withmarfa/shared` (the type / edge / zod-schema caches). The smoke at `pnpm --filter @withmarfa/server run smoke:worker-entry` is the build-time tripwire.
- **No `console.log`.** Handlers emit through `system.activity` (severity-tagged) via the `activity.ts` helpers; the substrate aggregates and persists.

## Build

`tsup` produces `dist/index.{js,d.ts}`. The package is consumed via the workspace link during dev (it depends on `@withmarfa/sdk` and `@withmarfa/shared`).

## Testing

`pnpm test` runs the Vitest suite. Coverage spans handler registration + dispatch (`handlers.test.ts`), cursor + echo-suppression semantics, the connection client's cycle-header stamping, queue-consumer retry / DLQ behavior, cron resolution, and activity-emission shape. All tests run under Node against the `in-memory-storage.ts` adapter.
