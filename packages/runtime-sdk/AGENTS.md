# @withmarfa/runtime-sdk

The SDK that Connection integrations import. Provides the handler-registration API, per-Connection state primitives, the connection-scoped client, echo suppression, and the dispatch glue the server's integration runtime calls into. **Published**, because it is the contract an integration is written against and an integration outside this repository cannot depend on a workspace reference.

**The breaking-change posture is the server's.** This package describes what the server's integration runtime will call and what it guarantees while doing so, so its major version tracks that contract rather than its own internals: a change that makes an existing handler stop compiling or stop behaving is a major, and everything else is not. It stays in this repository for the same reason. It is versioned in lockstep with the server that implements it, and a separate repository would only add a synchronisation problem.

The resumption contract is the exception, shipped as a minor: it is breaking, but every consumer moved onto it in the same delivery and none of them is outside this repository.

## Layout

Inside `src/`:

- `index.ts` — re-exports: `registerScheduleHandler`, `registerWebhookHandler`, `registerItemEventHandler`, `dispatchMessage`, type aliases for the handler signatures.
- `handlers.ts` — handler `REGISTRY` and `dispatchMessage`. Module-singleton state — every loader resolves to the same instance via shared's `noExternal` rule (see "Module singleton" below).
- `connection-client.ts` — `ConnectionClient`: thin wrapper over `@withmarfa/sdk` that stamps the cycle-metadata headers (`X-Marfa-Cycle-Origin`, `X-Marfa-Cycle-Hop`) and the connection's runtime credential.
- `connection-context.ts` — `ConnectionContext`: the object passed into every handler invocation. Holds the client, cursor, activity emitter, dispatch metadata.
- `cron.ts` — cron-expression resolution (`cron-parser`) for schedule handlers.
- `cursor-store.ts` — cursor-window primitives.
- `echo-suppression.ts` — exact-match, TTL-expiring suppression of events the integration itself just wrote, keyed per external id (prevents fanout-loops within hop-budget). Not probabilistic: a plain key-value record with an expiry, so there are no false positives to reason about.
- `activity.ts` — helpers for emitting `system.activity` rows.
- `budget.ts` — `createBudget`: the soft deadline a handler polls as `ctx.budget`. A boolean rather than a countdown, deliberately.
- `sweep.ts` — `sweep()`, the driver that turns a page loop into a resumable sweep. The adoption lever for the resumption contract; see below.
- `queue-consumer.ts` — `consumeBatch`, the dispatch engine (retry / DLQ / hop-budget enforcement) over structural `QueueDeliveryMessage` envelopes. The server's supervisor mirrors its semantics; the runtime-test harness drives it directly.

## The resumption contract

A scheduled sweep returns `SweepResult`, not `HandlerResult`. `done` is required, so a handler that has not finished has to say so and cannot be mistaken for one that has. Webhook and item-event handlers are unchanged: a delivery and an item event have nothing to continue.

A dispatch is bounded. `ctx.budget.shouldYield` is what a page loop polls, and `ctx.budget.signal` is what a `fetch` should be given so a call in flight at the deadline is not what carries the run past it.

**Four words, used precisely, because the design turns on the differences:**

- **watermark** — how far a _finished_ sweep got, in the provider's own domain key space (a timestamp, a monotonic id, a revision). Durable, committed as the sweep runs, and where a fresh sweep starts. Never an offset: "item 4,300" means nothing once the provider inserts something.
- **checkpoint** — where _this slice_ stopped. Lives in the queue payload, not the cursor, so a redelivered slice is deterministic and an unrelated dispatch running in the gap between slices cannot read it.
- **signpost** — the upper bound, frozen before the first page and held for the whole chain. An entry added mid-chain is next chain's problem. Without one, a provider that keeps writing can feed a sweep forever and it never reaches an end it can report.
- **sweep id** — a correlation identity for one chain. Handed to the author for idempotency keys, and compared by the runtime, so a straggler from an abandoned chain is discarded rather than appended to a chain nothing is tracking.

**`sweep()` does not carry a provider page token across a slice boundary unless the author opts in** with `resumeAcrossSlices`. A token valid for hours and one valid for five minutes have the same type signature, and a slice boundary can be minutes wide. An expired token produces an error the author sees; one the provider silently reinterprets produces a sweep that skips records and reports success. The default re-derives from the watermark, which costs at most one re-fetched page and cannot skip. Opt in per integration, once, having read the provider's documentation on token lifetime.

**Chains are bounded and abandoning one is cheap.** The supervisor stops a chain that exceeds its slice or wall-clock ceiling and records it where an operator can see it. Recovery is automatic — the watermark is committed per page, so the next scheduled tick starts fresh from wherever the abandoned chain reached — and that is exactly what buys the right to make the ceilings aggressive.

## Authoring rules

- **Module singleton — both packages externalized.** `@withmarfa/runtime-sdk` MUST be marked external in any bundle that loads integrations alongside it (the server bundle, the worker-entry script). The handler `REGISTRY` in `handlers.ts` is module-level state — if duplicated across the boundary the dispatch lookup silently misses. The same constraint applies to `@withmarfa/shared` (the type / edge / zod-schema caches). The smoke at `pnpm --filter @withmarfa/server run smoke:worker-entry` is the build-time tripwire.
- **No `console.log`.** Handlers emit through `system.activity` (severity-tagged) via the `activity.ts` helpers; the substrate aggregates and persists.

## Build

`tsup` produces `dist/index.{js,d.ts}`. The package is consumed via the workspace link during dev (it depends on `@withmarfa/sdk` and `@withmarfa/shared`).

## Testing

`pnpm test` runs the Vitest suite. Coverage spans handler registration + dispatch (`handlers.test.ts`), cursor + echo-suppression semantics, the connection client's cycle-header stamping, queue-consumer retry / DLQ behavior, cron resolution, and activity-emission shape. All tests run under Node against the `in-memory-storage.ts` adapter.
