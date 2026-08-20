# @withmarfa/runtime-test

In-memory mocks of the Cloudflare runtime primitives (DO storage + alarms, Queues, KV) plus a `createTestHarness` helper. Used by per-Integration test suites to drive their handlers without booting a real Worker runtime.

## When tests live here vs in the consuming package

- **`src/harness.test.ts`** — pins the harness primitives themselves (per-connection storage isolation, retry / fail outcomes from handler results, queue drain semantics).
- **`src/in-memory-{kv,queue,storage,alarm}.test.ts`** — pins each in-memory primitive in isolation.
- **`src/e2e-flow.test.ts`** — composes the runtime-sdk consumer with the harness across **two integrations in a chain** (webhook → primary handler → simulated reactive event → secondary handler). The single test that catches regressions in seam-crossings: `integration_name` envelope filter, base64 body decode at the dispatch seam, cycle metadata threading (`originating_connection_id`, `hop_count`).

The verify+enqueue side of the webhook flow is pinned by the server's webhook-receipt suite — that covers the `integration_name` stamp at the source. `e2e-flow.test.ts` picks up where that one leaves off (queue → handler → reactive → handler).

## Authoring new e2e flows

When a new seam crossing is worth pinning end-to-end:

1. Write the flow as one `it(...)` inside `e2e-flow.test.ts` if it composes the same primary→secondary shape.
2. Otherwise, create a new `<flow>-flow.test.ts` and add a corresponding fixture under `src/fixtures/` for any per-flow handler shapes.
3. The docstring at the top of the test file lists what the test catches if reverted, so future readers know which production fixes the test guards.

## Why module-level handler registry

`runtime-sdk/handlers.ts` keeps registered handlers in a module-level object. Tests call `_resetHandlers()` between phases when running multiple integrations in one test (one handler per kind per integration). The pattern is in `e2e-flow.test.ts` — `_resetHandlers()` between primary and secondary `consumeBatch` runs.

## Build

`tsup` produces `dist/index.js` and `dist/index.d.ts` from `src/index.ts`. The fixtures directory is intentionally not exported — fixtures are test-only.
